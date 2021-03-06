var mongodb = require('mongodb');
var ObjectID = require('mongodb').ObjectID;

exports.saveChanges = function(db, req, callback) {
    var body = req.body;

    var saveHandler = new SaveHandler(db, body.entities, body.saveOptions, body.metadata, callback);
    saveHandler.save();
} ;

var SaveHandler = function(db, entities, saveOptions, metadata, callback) {
    this.db = db;
    this.entities = entities;
    this.saveOptions = saveOptions;
    this.metadata = metadata;
    this.callback = callback;

    this.saveCountPending = 0;
    this.allCallsCompleted = false;
    this.insertedKeys = [];
    this.updatedKeys = [];
    this.deletedKeys = [];
    this.keyMappings = [];
    this.possibleFixupMap = {};

};

SaveHandler.prototype.save = function() {
    var groupedEntities = groupBy(this.entities, function(e) {
        return e.entityAspect.defaultResourceName;
    });

    var pendingCollections = objectMap(groupedEntities, this._prepareCollection.bind(this));
    this._fixupFks(pendingCollections);
    var that = this;
    pendingCollections.forEach(function(pc) {
        that._saveCollection(pc);
    });
    this.allCallsCompleted = true;
}

SaveHandler.prototype._prepareCollection = function(resourceName, entities) {
    var insertDocs = [];
    var updateDocs = [];
    var deleteDocs = [];
    var that = this;
    entities.forEach(function(e) {
        var entityAspect = e.entityAspect;
        var entityState = entityAspect.entityState;
        var entityTypeName = entityAspect.entityTypeName;
        var entityType = that.metadata[entityTypeName];
        entityType.name = entityTypeName;
        // TODO: we really only need to coerce every field on an insert
        // only selected fields are needed for update and delete.
        that._coerceData(e, entityType, resourceName);
        var entityKey = { entityTypeName: entityTypeName, _id: e._id } ;
        if (entityState === "Added") {
            delete e.entityAspect;

            var autoGeneratedKey = entityType.autoGeneratedKey;
            if (autoGeneratedKey) {
                if (autoGeneratedKey.propertyName !== "_id") {
                    that._raiseError(new Error("The key in a MongoDb must be called '_id'"));
                    return;
                }
                var keyDataType = entityType.keyDataType;
                if (keyDataType === "Guid") {
                    e._id = createGuid();
                } else if (keyDataType == "MongoObjectId") {
                    // instead of omitting the _id and having mongo update it, we wnat to set it ourselves so that we can do
                    // fk fixup before going async
                    e._id = new ObjectID();
                } else {
                    that._raiseError(new Error("ObjectIds and Guids are the only autoGenerated key types that Breeze currently supports, not: " + keyDataType));
                    return;
                }
            }

            if (entityKey._id !== e._id) {
                keyMapping = { entityTypeName: entityKey.entityTypeName, tempValue: entityKey._id, realValue: e._id };
                that.keyMappings.push(keyMapping);
            }
            var insertDoc = {
                entity: e,
                entityKey: entityKey
            };
            insertDocs.push(insertDoc);
        } else if (entityState === "Modified") {
            var criteria = { "_id": e._id };
            if (entityType.concurrencyProp) {
                // Note that the Breeze client will insure that the current value has been updated.
                // so no need to do that here
                var propName = entityType.concurrencyProp.name;
                criteria[propName] = entityAspect.originalValuesMap[propName];
            }
            setMap = {};
            Object.keys(entityAspect.originalValuesMap).forEach(function(k) {
                setMap[k] = e[k];
            });
            var updateDoc = {
                criteria: criteria,
                setOps: { $set: setMap },
                entityKey: entityKey,
                hasConcurrencyCheck: !!entityType.concurrencyProp
            };
            updateDocs.push(updateDoc);
        } else if (entityState = "Deleted") {
            var criteria = { "_id": e._id };
            // we don't bother with concurrency check on deletes
            // TODO: we may want to add a 'switch' for this later.
            var deleteDoc = {
                criteria: criteria,
                entityKey: entityKey
            };
            deleteDocs.push(deleteDoc);
        }
    });
    return {
        resourceName: resourceName,
        inserts: insertDocs,
        updates: updateDocs,
        deletes: deleteDocs
    };

};

SaveHandler.prototype._saveCollection=function(pc) {
    this.saveCountPending += pc.inserts.length + pc.updates.length + pc.deletes.length;
    var saveOptions = { safe: true }
    var that = this;
    this.db.collection(pc.resourceName, {strict: true} , function (err, collection) {
        pc.inserts.forEach(function (iDoc) {
            collection.insert(iDoc.entity, saveOptions, function(err, object) {
                that._handleInsert(iDoc, err, object);
            });
        });
        pc.updates.forEach(function (uDoc) {
            collection.update( uDoc.criteria, uDoc.setOps, saveOptions, function(err, object) {
                that._handleUpdate(uDoc, err, object);
            })
        });
        pc.deletes.forEach(function (dDoc) {
            collection.remove( dDoc.criteria, true, function(err, object) {
                that._handleDelete(dDoc, err, object);
            })
        });
    });
};

SaveHandler.prototype._coerceData = function(entity, entityType) {
    var that = this;
    entityType.dataProperties.forEach(function(dp) {
        var dt = dp.dataType;
        // if this is an fk column and it has a value
        // create a map of entities that may need to be fixed up - keyed by the tempFkValue ( which may be a realFkValue already).
        // Note this works because in mongo all fkValues must refer to an _id field as the paired key.
        if (dp.isFk && entity[dp.name]) {
            var fk = entity[dp.name];
            if (dp.name === "_id") {
                that._raiseError(new Error("The '_id' property cannot itself be a foreignKey in a mongoDb - Please check you metadata for entityType: " + entityType.name));
            }
            var possibleFixups = that.possibleFixupMap[fk];
            if (!possibleFixups) {
                possibleFixups = [];
                that.possibleFixupMap[fk] = possibleFixups;
            }
            possibleFixups.push( { _id: entity._id, fkProp: dp.name  });
        }

        if (dp.name === "_id") {
            entityType.keyDataType = dt;
        }
        if (dp.isConcurrencyProp) {
            entityType.concurrencyProp = dp;
        }

        var val = entity[dp.name];
        if (val == null) {
            // this allows us to avoid inserting a null.
            // TODO: think about an option to allow this if someone really wants to.
            delete entity[dp.name];
            return;
        }

        if (dt === "MongoObjectId") {
            if (val) {
                try {
                    entity[dp.name] = ObjectID.createFromHexString(val);
                } catch (err) {
                    that._raiseError(new Error("Unable to convert the value: '" + val + "' to a Mongo ObjectID"));
                }
            }
        } else if (dt === "DateTime" || dt === "DateTimeOffset") {
            if (val) {
                entity[dp.name] = new Date(Date.parse(val));
            }
        }
    })
};

SaveHandler.prototype._handleInsert = function(insertDoc, err, insertedObjects) {
    if (this._checkIfError(err)) return;
    if ((!insertedObjects) || insertedObjects.length !== 1) {
        this.callback(new Error("Not inserted: " + formatEntityKey(insertDoc.entityKey)));
    }
    this.insertedKeys.push(insertDoc.entityKey);
    this._checkIfCompleted();
};

SaveHandler.prototype._handleUpdate = function (updateDoc, err, wasUpdated) {
    if (this._checkIfError(err)) return;
    if (!wasUpdated) {
        var msg = updateDoc.hasConcurrencyCheck
            ? ". This may be because of the concurrency check performed during the save."
            : ".";
        this._raiseError(new Error("Not updated: " + formatEntityKey(updateDoc.entityKey) + msg));
    }
    this.updatedKeys.push( updateDoc.entityKey );
    this._checkIfCompleted();
};

SaveHandler.prototype._handleDelete = function (deleteDoc, err, wasDeleted) {
    if (this._checkIfError(err)) return;
    if (!wasDeleted) {
        this._raiseError(new Error("Not deleted: " + formatEntityKey(deleteDoc.entityKey)));
    }
    this.deletedKeys.push( deleteDoc.entityKey );
    this._checkIfCompleted();
};

SaveHandler.prototype._fixupFks = function(pcs) {
    if (this.keyMappings.length === 0) return;
    // pendingMap is a map of _id to pendingDoc
    var pendingMap = {};
    pcs.forEach(function(pc) {
        pc.inserts.concat(pc.updates).forEach(function(doc) {
            pendingMap[doc.entityKey._id] = doc;
        })
    });

    // kmMap is a map of tempFkValue -> keyMapping
    var kmMap = {};
    this.keyMappings.forEach(function(km) {
        kmMap[km.tempValue] = km;
    });

    // possibleFixupMap is a map of fkValue -> [] of possibleFixups { _id:, fkProp: }
    for (fkValue in this.possibleFixupMap) {
        var km = kmMap[fkValue];
        if (km) {
            // if we get to here we know that we have an fk or fks that need updating
            var realValue = km.realValue;
            var pendingFixups = this.possibleFixupMap[fkValue];
            pendingFixups.forEach(function(pendingFixup) {
                // update the pendingDoc with the new real fkValue
                // next line is for debug purposes
                pendingFixup.fkValue = realValue;
                var pendingDoc = pendingMap[pendingFixup._id];
                if (pendingDoc.criteria) {
                    pendingDoc.setOps.$set[pendingFixup.fkProp] = realValue;
                } else {
                    pendingDoc.entity[pendingFixup.fkProp] = realValue;
                }
            });
        }
    }
};

SaveHandler.prototype._raiseError = function(error) {
    if (this._isAllDone) return;
    this._isAllDone = true;
    this.callback(error);
};

SaveHandler.prototype._checkIfError = function(err) {
    if (err) {
        this._raiseError(err);
    }
    return err != null;
};

SaveHandler.prototype._checkIfCompleted = function() {
    if (this._isAllDone) return;
    this.saveCountPending -= 1;
    if (this.saveCountPending > 0) return;
    if (!this.allCallsCompleted) return;
    this._isAllDone = true;
    this.callback(null, {
        insertedKeys: this.insertedKeys,
        updatedKeys:  this.updatedKeys,
        deletedKeys:  this.deletedKeys,
        keyMappings:  this.keyMappings
    });
};

function formatEntityKey(ek) {
    return ek.entityTypeName + ": " + ek._id;
}

// returns an array with each item corresponding to the kvFn eval'd against each prop.
function objectMap(obj, kvFn) {
    var results = [];
    for (var key in obj) {
        if ( obj.hasOwnProperty(key)) {
            var r = kvFn(key, obj[key]);
            results.push(r);
        }
    }
    return results;
}

function groupBy(arr, keyFn) {
    var groups = {};
    arr.forEach(function (v) {
        var key = keyFn(v);
        var group = groups[key];
        if (!group) {
            group = [];
            groups[key] = group;
        }
        group.push(v);
    })
    return groups;
}

function createGuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
