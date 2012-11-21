require.config({ baseUrl: "Scripts/IBlade" });

define(["testFns"], function (testFns) {
    var breeze = testFns.breeze;
    var core = breeze.core;
    

    var Enum = core.Enum;

    var MetadataStore = breeze.MetadataStore;
    var EntityManager = breeze.EntityManager;
    var AutoGeneratedKeyType = breeze.AutoGeneratedKeyType;
    var SaveOptions = breeze.SaveOptions;
    var EntityQuery = breeze.EntityQuery;
    var EntityKey = breeze.EntityKey;
    var EntityState = breeze.EntityState;
    var FilterQueryOp = breeze.FilterQueryOp;

    var newEm = testFns.newEm;
    

    module("save", {
        setup: function () {
            testFns.setup({
                metadataFn: function() {
                    var regionType = testFns.metadataStore.getEntityType("Region");
                    regionType.setProperties({ autoGeneratedKeyType: AutoGeneratedKeyType.KeyGenerator });
                    var territoryType = testFns.metadataStore.getEntityType("Territory");
                    territoryType.setProperties({ autoGeneratedKeyType: AutoGeneratedKeyType.KeyGenerator });
                }
            });
        },
        teardown: function () { }
    });
    
    if (!testFns.DEBUG_WEBAPI) {
        test("OData saves not yet supported", function () {
            ok(false, "Skipped tests - ok to fail - Breeze OData does not yet support Saves");
        });
        return testFns;
    };

    test("noop", function() {
        var em = newEm();
        var q = new EntityQuery("Customers");
        stop();
        q.using(em).execute().then(function(data) {
            return em.saveChanges();
        }).then(function(sr) {
            ok(Array.isArray(sr.entities));
            ok(sr.entities.length == 0);
            ok(!em.hasChanges());
        }).fail(testFns.handleFail).fin(start);
    });

    test("unmapped save", function() {

        // use a different metadata store for this em - so we don't polute other tests
        var em1 = newEm();
        var Customer = testFns.models.CustomerWithMiscData();
        em1.metadataStore.registerEntityTypeCtor("Customer", Customer);
        stop();
        var q = new EntityQuery("Customers")
            .where("companyName", "startsWith", "C");
        q.using(em1).execute().then(function(data) {
            var customers = data.results;
            customers.every(function(c) {
                ok(c.getProperty("miscData") == "asdf", "miscData should == 'asdf'");

            });
            var cust = customers[0];
            cust.setProperty("miscData", "xxx");
            ok(cust.entityAspect.entityState == EntityState.Unchanged);
            ok(!em1.hasChanges(), "should not have changes")
            return em1.saveChanges();
        }).then(function(sr) {
            var saved = sr.entities;
            ok(saved.length === 0);
            ok(!em1.hasChanges());
        }).fail(testFns.handleFail).fin(start);
    });
    
    test("add parent and children", function () {
        var em = newEm();
        var zzz = createParentAndChildren(em);
        stop();
        em.saveChanges(null, null,
            function(saveResult) {
                ok(zzz.cust1.entityAspect.entityState.isUnchanged());
                ok(zzz.cust2.entityAspect.entityState.isUnchanged());
                ok(zzz.order1.entityAspect.entityState.isUnchanged());
                ok(zzz.order2.entityAspect.entityState.isUnchanged());
                ok(zzz.cust1.getProperty("customerID") != zzz.keyValues[0], "cust1.customerID should not match original values");
                ok(zzz.cust2.getProperty("customerID") != zzz.keyValues[1], "cust2.customerID should not match original values");
                ok(zzz.order1.getProperty("orderID") != zzz.keyValues[2]);
                ok(zzz.order2.getProperty("orderID") != zzz.keyValues[3]);
                ok(zzz.order1.getProperty("customer") === zzz.cust1);
                ok(zzz.order2.getProperty("customer") === zzz.cust1);
                ok(zzz.cust1.getProperty("orders").length === 2);
                ok(zzz.cust2.getProperty("orders").length === 0);
                ok(!em.hasChanges());
            }, function(err) {
                ok(false, "should not get here - " + err);
            }).fail(testFns.handleFail).fin(start);
    });

    test("allow concurrent saves with concurrency column", 2, function() {
        var em = newEm();
        em.saveOptions = new SaveOptions({ allowConcurrentSaves: true });
        var q = new EntityQuery()
            .from("Customers")
            .take(2);
        stop();
        
        var cust;
        var savedCount = 0;
        
        function handleSaveResult(sr) {
            savedCount = savedCount + 1;
            if (savedCount == 1) {
                ok(true, "should have gotten here");
                return;
            }
            if (savedCount == 2) {
                ok(false, "second fail should have failed");
                start();
            }
        }
        
        function handleFailResult(err) {
            var msg = err.message;
            if ( msg.indexOf("Store update, insert")>=0) {
                ok(true, "should also have gotten here");
                start();
            } else {
                ok(false, "should not get here: " + msg);
                start();
            }
        }

        em.executeQuery(q).then(function(data) {
            // query cust
            cust = data.results[0];
            testFns.morphStringProp(cust, "companyName");

            em.saveChanges().then(function(sr) {
                handleSaveResult(sr);
            }).fail(function(e) {
                handleFailResult(e);
            });
            em.saveChanges().then(function(sr) {
                handleSaveResult(sr);
            }).fail(function(e) {
                handleFailResult(e);
            });
        }).fail(testFns.handleFail);
    });
    
    test("allow concurrent saves with NO concurrency column", 2, function() {
        var em = newEm();
        em.saveOptions = new SaveOptions({ allowConcurrentSaves: true });
        var q = new EntityQuery()
            .from("Products")
            .take(2);

        stop();
        var prod;
        
        var savedCount = 0;
        
        function handleSaveResult(sr) {
            savedCount = savedCount + 1;
            if (savedCount == 1) {
                ok(true, "should have gotten here");
                return;
            }
            if (savedCount == 2) {
                ok(true, "this is good");
                start();
            }
        }
        
        function handleFailResult(err) {
            var msg = err.message;
            ok(false, "should not get here: " + msg);
            start();
        }

        em.executeQuery(q).then(function(data) {
            // query cust
            prod = data.results[0];
            var price = prod.getProperty("unitPrice");
            prod.setProperty("unitPrice", price + .01);

            em.saveChanges().then(function(sr) {
                handleSaveResult(sr);
            }).fail(function(e) {
                handleFailResult(e);
            });
            em.saveChanges().then(function(sr) {
                handleSaveResult(sr);
            }).fail(function(e) {
                handleFailResult(e);
            });
        }).fail(testFns.handleFail);
    });
    
    test("disallow concurrent saves with NO concurrency column",2, function() {
        var em = newEm();
        // Next line is not needed because it is the default
        // em.saveOptions = new SaveOptions({ allowConcurrentSaves: false });
        var q = new EntityQuery()
            .from("Products")
            .take(2);

        stop();
        var prod;
        
        var savedCount = 0;
        var failedCount = 0;
        
        function handleSaveResult(sr) {
            savedCount = savedCount + 1;
            if (savedCount == 1) {
                ok(true, "should have gotten here");
                if (failedCount == 1) {
                    start();
                }
                return;
            }
            if (savedCount == 2) {
                ok(false, "second fail should have failed");
                start();
            }
        }
        
        function handleFailResult(err) {
            failedCount = failedCount + 1;
            var msg = err.message;
            if ( msg.indexOf("allowConcurrentSaves")>=0) {
                ok(true, "should also have gotten here");
                if (savedCount == 1) {
                    start();
                }
            } else {
                ok(false, "should not get here: " + msg);
                start();
            }
        }

        em.executeQuery(q).then(function(data) {
            // query cust
            prod = data.results[0];
            var price = prod.getProperty("unitPrice");
            prod.setProperty("unitPrice", price + .01);

            em.saveChanges().then(function(sr) {
                handleSaveResult(sr);
            }).fail(function(e) {
                handleFailResult(e);
            });
            em.saveChanges().then(function(sr) {
                handleSaveResult(sr);
            }).fail(function(e) {
                handleFailResult(e);
            });
        }).fail(testFns.handleFail);
    });

    test("modify one", function () {
        var em = newEm();
        var query = new EntityQuery()
            .from("Customers")
            .where("companyName", "startsWith", "C")
            .take(2);
        stop();
        em.executeQuery(query, function(data) {
            var cust = data.results[0];
            var orders = cust.getProperty("orders");
            var companyName = cust.getProperty("companyName");
            var newCompanyName = testFns.morphString(companyName);
            cust.setProperty("companyName", newCompanyName);
            em.saveChanges(null, null, function (saveResult) {
                ok(!em.hasChanges());
                var entities = saveResult.entities;
                ok(entities.length === 1);
                ok(saveResult.keyMappings.length === 0);
                ok(entities[0] === cust);
                ok(cust.getProperty("companyName") === newCompanyName);
                ok(cust.entityAspect.entityState.isUnchanged());
                var q2 = EntityQuery.fromEntities(cust);
                em.executeQuery(q2, function(data2) {
                    var entities2 = data2.results;
                    ok(entities2.length === 1);
                    ok(entities2[0] === cust);
                    ok(cust.getProperty("companyName") === newCompanyName);
                    start();
                }, testFns.handleFail);
            }, testFns.handleFail);
        }, testFns.handleFail);
    });

    test("modify parent and children", function () {
        var em = newEm();
        var query = new EntityQuery()
            .from("CustomersAndOrders")
            .where("companyName", "startsWith", "C")
            .take(5);
        stop();
        em.executeQuery(query, function(data) {
            var cust = core.arrayFirst(data.results, function(c) {
                return c.getProperty("orders").length > 0;
            });
            ok(cust, "unable to find a customer with orders");

            var companyName = cust.getProperty("companyName");
            var newCompanyName = testFns.morphStringProp(cust, "companyName");
            ok(cust.entityAspect.entityState.isModified(), "should be modified");
            var orders = cust.getProperty("orders");
            orders.forEach(function(o) {
                testFns.morphStringProp(o, "shipName");
                ok(o.entityAspect.entityState.isModified(), "should be modified");
            });
            em.saveChanges(null, null, function (saveResult) {
                ok(!em.hasChanges());
                var entities = saveResult.entities;
                ok(entities.length === 1 + orders.length, "wrong number of entities returned");
                ok(saveResult.keyMappings.length === 0, "no key mappings should be returned");

                entities.forEach(function(e) {
                    ok(e.entityAspect.entityState.isUnchanged, "entity is not in unchanged state");
                    if (e.entityType === cust.entityType) {
                        ok(e === cust, "cust does not match");
                    } else {
                        ok(orders.indexOf(e) >= 0, "order does not match");
                    }
                });

                ok(cust.getProperty("companyName") === newCompanyName, "company name was not changed");
                ok(cust.entityAspect.entityState.isUnchanged(), "entityState should be unchanged");
                var q2 = EntityQuery.fromEntities(cust);

                em.executeQuery(q2, function(data2) {
                    var entities2 = data2.results;
                    ok(entities2.length === 1, "should only get a single entity");
                    ok(entities2[0] === cust, "requery does not match cust");
                    ok(cust.getProperty("companyName") === newCompanyName, "company name was not changed on requery");
                }).fail(testFns.handleFail);
            }).fail(testFns.handleFail);
        }).fail(testFns.handleFail).fin(start);
    });

    test("delete parent, children stranded", function () {
        var em = newEm();
        var zzz = createParentAndChildren(em);
        stop();
        em.saveChanges(null, null, function(saveResult) {
            zzz.cust1.entityAspect.setDeleted();
            em.saveChanges(null, null, function(sr) {
                ok(false, "shouldn't get here");
            }).fail(function (error) {
                ok(em.hasChanges());
                ok(error instanceof Error, "should be an error");
                ok(error.message.indexOf("FOREIGN KEY") >= 0, "message should contain 'FOREIGN KEY'");
            });
        }).fail(testFns.handleFail).fin(start);
    });

    test("delete parent then delete children", function () {
        var em = newEm();
        var zzz = createParentAndChildren(em);
        stop();
        em.saveChanges(null, null, function (saveResult) {
            ok(!em.hasChanges());
            zzz.cust1.entityAspect.setDeleted();
            zzz.order1.entityAspect.setDeleted();
            zzz.order2.entityAspect.setDeleted();
            ok(zzz.order1.entityAspect.entityState.isDeleted(), "should be marked as deleted");
            ok(zzz.cust1.entityAspect.entityState.isDeleted(), "should be marked as deleted");
            ok(em.hasChanges());
            em.saveChanges(null, null, function (sr) {
                ok(!em.hasChanges());
                ok(sr.entities.length === 3, "should be 3 entities saved");
                ok(zzz.order1.entityAspect.entityState.isDetached(), "order1 should be marked as detached");
                ok(zzz.order2.entityAspect.entityState.isDetached(), "order2 should be marked as detached");
                ok(zzz.cust1.entityAspect.entityState.isDetached(), "cust1 should be marked as detached");
            }).fail(testFns.handleFail);
        }).fail(testFns.handleFail).fin(start);
    });

    test("delete children then delete parent", function () {
        var em = newEm();
        var zzz = createParentAndChildren(em);
        stop();
        em.saveChanges().then(function(saveResult) {
            var orders = zzz.cust1.getProperty("orders");
            ok(zzz.order1 === orders[0]);
            var cust1a = zzz.order1.getProperty("customer");
            ok(cust1a === zzz.cust1);


            zzz.order1.entityAspect.setDeleted();
            zzz.order2.entityAspect.setDeleted();
            zzz.cust1.entityAspect.setDeleted();
            ok(zzz.order1.entityAspect.entityState.isDeleted(), "should be marked as deleted");
            ok(zzz.cust1.entityAspect.entityState.isDeleted(), "should be marked as deleted");
            return em.saveChanges();
        }).then(function (sr) {
            ok(!em.hasChanges());
            ok(sr.entities.length === 3, "should be 3 entities saved");
            ok(zzz.order1.entityAspect.entityState.isDetached(), "order1 should be marked as detached");
            ok(zzz.order2.entityAspect.entityState.isDetached(), "order2 should be marked as detached");
            ok(zzz.cust1.entityAspect.entityState.isDetached(), "cust1 should be marked as detached");
        }).fail(testFns.handleFail).fin(start);
    });
    
    test("delete children then delete parent after query", function () {
        var em = newEm();
        var em2 = newEm();
        var zzz = createParentAndChildren(em);
        stop();
        em.saveChanges().then(function(saveResult) {
            var q = EntityQuery.fromEntities(zzz.cust1);
            q = EntityQuery.from("CustomersAndOrders").where(q.wherePredicate);
            return em2.executeQuery(q);
        }).then(function(data) {
            var cust = data.results[0];
            var orders = cust.getProperty("orders").slice(0);
            orders.forEach(function(o) {
                o.entityAspect.setDeleted();
            });
            cust.entityAspect.setDeleted();
            ok(orders[0].entityAspect.entityState.isDeleted(), "should be marked as deleted");
            ok(cust.entityAspect.entityState.isDeleted(), "should be marked as deleted");
            return em2.saveChanges();
        }).then(function (sr) {
            ok(!em2.hasChanges());
            ok(sr.entities.length === 3, "should be 3 entities saved");
            sr.entities.forEach(function(e) {
                ok(e.entityAspect.entityState.isDetached(), "entity should be marked as detached");
            });
        }).fail(testFns.handleFail).fin(start);
    });

    test("delete children, leave parent alone", function () {
        var em = newEm();
        var zzz = createParentAndChildren(em);
        stop();
        em.saveChanges(null, null, function(saveResult) {

            zzz.order1.entityAspect.setDeleted();

            ok(zzz.cust1.getProperty("orders").length === 1, "should only be 1 order now");
            zzz.order2.entityAspect.setDeleted();
            ok(zzz.cust1.getProperty("orders").length === 0, "should be no orders now");
            ok(zzz.order1.entityAspect.entityState.isDeleted(), "should be marked as deleted");
            ok(zzz.cust1.entityAspect.entityState.isUnchanged(), "should be unchanged");
            em.saveChanges(null, null, function (sr) {
                ok(!em.hasChanges());
                ok(zzz.order1.entityAspect.entityState.isDetached(), "should be marked as detached");
                ok(zzz.cust1.getProperty("orders").length === 0, "should be no orders now");
            }).fail(testFns.handleFail);
        }).fail(testFns.handleFail).fin(start);
    });

    test("delete parent, move children", function () {
        var em = newEm();
        var zzz = createParentAndChildren(em);
        stop();
        em.saveChanges().then(function(saveResult) {

            zzz.cust1.entityAspect.setDeleted();
            zzz.order1.setProperty("customer", zzz.cust2);
            ok(zzz.order1.entityAspect.entityState.isModified(), "should be marked as modified");
            zzz.order2.setProperty("customer", zzz.cust2);
            ok(zzz.cust1.entityAspect.entityState.isDeleted(), "should be marked as deleted");

            em.saveChanges(null, null, function (sr2) {
                ok(!em.hasChanges());
                ok(sr2.entities.length === 3);
                ok(zzz.cust1.entityAspect.entityState.isDetached(), "should be marked as detached");
                ok(zzz.order1.entityAspect.entityState.isUnchanged(), "should be marked as unchanged");
            }).fail(testFns.handleFail);
        }).fail(testFns.handleFail).fin(start);
    });

    test("concurrency violation", function () {
        var em = newEm();
        var em2 = newEm();
        var q = new EntityQuery()
            .from("Customers")
            .take(2);

        stop();
        var cust;
        var sameCust;
        em.executeQuery(q).then(function(data) {
            // query cust
            cust = data.results[0];
            var q2 = EntityQuery.fromEntities(cust);
            return em2.executeQuery(q2);
        }).then(function(data2) {
            // query same cust in dif em
            // and modify it and resave it
            ok(data2.results.length == 1, "should only have 1 result");
            sameCust = data2.results[0];
            ok(cust.entityAspect.getKey().equals(sameCust.entityAspect.getKey()), "should be the same key");
            testFns.morphStringProp(sameCust, "companyName");
            return em2.saveChanges();
        }).then(function(sr2) {
            testFns.morphStringProp(cust, "companyName");
            return em.saveChanges();
        }).then(function(sr2) {
            ok(false, "should not get here, save should have failed");
        }, function (error) {
            ok(em.hasChanges());
            ok(error.detail.ExceptionType.toLowerCase().indexOf("concurrency") >= 0, "wrong error message: " + error.detail.ExceptionType);
        }).fail(testFns.handleFail).fin(start);
    });
    
    test("concurrency violation on delete", function () {
        ok(false, "not yet implemented");
    });

    test("insert of existing entity", function () {
        var em = newEm();
        var q = new EntityQuery()
            .from("OrderDetails")
            .take(2);

        stop();
        var em2;
        em.executeQuery(q).then(function(data) {
            var od = data.results[0];
            em.detachEntity(od);
            em2 = newEm();
            em2.addEntity(od);
            return em2.saveChanges();
        }).then(function (sr) {
            ok(false, "shouldn't get here");
            start();
        }, function (error) {
            ok(em2.hasChanges());
            ok(error.message.toLowerCase().indexOf("primary key constraint") >= 0, "wrong error message");
        }).fail(testFns.handleFail).fin(start);
    });

    test("insert with generated key", function () {
        var em = newEm();

        var region1 = createRegion(em, "1");
        var k1 = region1.entityAspect.getKey();

        var region2 = createRegion(em, "2");
        var k2 = region2.entityAspect.getKey();

        stop();
        em.saveChanges().then(function (data) {
            ok(!em.hasChanges());
            ok(data.entities.length === 2);
            ok(!region1.entityAspect.getKey().equals(k1));
            ok(!region2.entityAspect.getKey().equals(k2));
            return data;
        }).then(function(data2) {
            // curious about synchronous results
            ok(data2.entities.length == 2);
        }).fail(testFns.handleFail).fin(start);
    });

    test("insert with relationships with generated key", function () {
        var em = newEm();

        var region1 = createRegion(em, "1");
        var k1 = region1.entityAspect.getKey();
        var terrs1 = region1.getProperty("territories");
        var terr1a = createTerritory(em, "1a");
        var terr1b = createTerritory(em, "1b");
        terrs1.push(terr1a);
        terrs1.push(terr1b);

        var region2 = createRegion(em, "2");
        var k2 = region2.entityAspect.getKey();
        var terrs2 = region2.getProperty("territories");
        var terr2a = createTerritory(em, "1a");
        var terr2b = createTerritory(em, "1b");
        terrs2.push(terr2a);
        terrs2.push(terr2b);

        stop();
        em.saveChanges().then(function (data) {
            ok(!em.hasChanges());
            ok(data.entities.length === 6);
            ok(!region1.entityAspect.getKey().equals(k1));
            var terrs1x = region1.getProperty("territories");
            ok(terrs1x === terrs1);
            ok(terrs1x.length == 2);
            ok(!region2.entityAspect.getKey().equals(k2));
            var terrs2x = region2.getProperty("territories");
            ok(terrs2x === terrs2);
            ok(terrs2x.length == 2);
            ok(terrs2x[0].getProperty("region") === region2);
        }).fail(testFns.handleFail).fin(start);
    });

    test("save of deleted entity should not trigger validation", function() {
        var em = newEm();
        var region = createRegion(em, "x1");
        stop();
        ok(em.hasChanges());
        em.saveChanges().then(function (sr) {
            ok(!em.hasChanges());
            ok(sr.entities.length === 1, "one entity should have been saved");
            ok(sr.entities[0] === region, "save result should contain region");
            region.setProperty("regionDescription", "");
            region.entityAspect.setDeleted();
            ok(em.hasChanges());
            return em.saveChanges();
        }).then(function (sr2) {
            ok(!em.hasChanges());
            ok(sr2.entities.length === 1, "one entity should have been saved");
            ok(sr2.entities[0] === region, "save result should contain region");
            ok(region.entityAspect.entityState.isDetached(), "region should now be detached");
        }).fail(testFns.handleFail).fin(start);
    });

    test("bad save call", function () {
        var em = newEm();
        try {
            em.saveChanges(null, new SaveOptions(), "adfa");
        } catch (e) {
            ok(e.message.indexOf("callback") >= 0);
        }
        try {
            em.saveChanges(null, "adfa");
        } catch (e) {
            ok(e.message.indexOf("SaveOptions") >= 0);
        }
        try {
            em.saveChanges("adfa");
        } catch (e) {
            ok(e.message.indexOf("entities") >= 0);
        }

    });

    test("cleanup  test data", function() {
        var em = newEm();
        var q = EntityQuery.from("CustomersAndOrders")
            .where("companyName", FilterQueryOp.StartsWith, "Test");
        stop();
        em.executeQuery(q).then(function(data) {
            data.results.forEach(function(cust) {
                var orders = cust.getProperty("orders").slice(0);
                orders.forEach(function(order) {
                    order.entityAspect.setDeleted();
                });
                cust.entityAspect.setDeleted();
            });
            return em.saveChanges();
        }).then(function(sr) {
            ok(sr, "save failed");
            ok(sr.entities.length, "deleted count:" + sr.entities.length);
            start();
        }).fail(testFns.handleFail);
    });

     function createParentAndChildren(em) {
        var metadataStore = testFns.metadataStore;
        var custType = metadataStore.getEntityType("Customer");
        var orderType = metadataStore.getEntityType("Order");
        var cust1 = custType.createEntity();
        cust1.setProperty("companyName", "Test_js_1");
        cust1.setProperty("city", "Oakland");
        cust1.setProperty("rowVersion", 13);
        cust1.setProperty("fax", "510 999-9999");
        var cust2 = custType.createEntity();
        cust2.setProperty("companyName", "Test_js_2");
        cust2.setProperty("city", "Emeryville");
        cust2.setProperty("rowVersion", 1);
        cust2.setProperty("fax", "510 888-8888");
        em.addEntity(cust1);
        em.addEntity(cust2);
        var order1 = orderType.createEntity();
        var order2 = orderType.createEntity();
        var orders = cust1.getProperty("orders");
        orders.push(order1);
        orders.push(order2);
        var keyValues = [cust1.getProperty("customerID"),
            cust2.getProperty("customerID"),
            order1.getProperty("orderID"),
            order2.getProperty("orderID")];
        return {
            cust1: cust1,
            cust2: cust2,
            order1: order1,
            order2: order2,
            keyValues: keyValues
        };
    }

    function createRegion(em, descr) {
        var regionType = testFns.metadataStore.getEntityType("Region");
        var region = regionType.createEntity();
        
        region.setProperty("regionDescription", "Test-" + descr + "-" + new Date().toDateString());
        em.addEntity(region);
        return region;
    }

    function createTerritory(em, descr) {
        var territoryType = testFns.metadataStore.getEntityType("Territory");
        var territory = territoryType.createEntity();
        territory.setProperty("territoryDescription", "Test-" + descr + "-" + new Date().toDateString());
        em.addEntity(territory);
        return territory;
    }
    return testFns;
});