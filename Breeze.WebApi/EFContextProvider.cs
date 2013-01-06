﻿using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Configuration;
using System.Data;
using System.Data.Entity;
using System.Data.Entity.Infrastructure;
using System.Data.Entity.Validation;
using System.Data.EntityClient;
using System.Data.Metadata.Edm;
using System.Data.Objects;
using System.Data.Objects.DataClasses;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Xml;
using System.Xml.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;
using Newtonsoft.Json.Linq;

namespace Breeze.WebApi {


  // T is either a subclass of DbContext or a subclass of ObjectContext
  public class EFContextProvider<T> : ContextProvider where T : class, new() {

    public EFContextProvider() {
      
    }

    [Obsolete("The contextName is no longer needed. This overload will be removed after Dec 31st 2012.")]
    public EFContextProvider(string contextName) {
      
    } 

    public T Context {
      get {
        if (_context == null) {
          _context = CreateContext();
          // Disable lazy loading and proxy creation as this messes up the data service.
          if (typeof(ObjectContext).IsAssignableFrom(typeof(T))) {
            var objCtx = (ObjectContext)(Object)_context;
            objCtx.ContextOptions.LazyLoadingEnabled = false;
          } else {
            var dbCtx = (DbContext)(Object)_context;
            dbCtx.Configuration.ProxyCreationEnabled = false;
            dbCtx.Configuration.LazyLoadingEnabled = false;
          }
        }
        return _context;
      }
    }

    protected virtual T CreateContext() {
      return new T();
    }

    public ObjectContext ObjectContext {
      get {
        if (Context is DbContext) {
          return ((IObjectContextAdapter) Context).ObjectContext;
        } else {
          return (ObjectContext) (Object) Context;
        } 
      }
    }

    private IDbConnection DbConnection {
      get {
        var ec = ObjectContext.Connection as EntityConnection;
        if (ec != null) {
          return ec.StoreConnection;
        } else {
          throw new Exception("Unable to create a StoreConnection");
        }
      }
    }

    #region Base implementation overrides

    protected override string BuildJsonMetadata() {

      XDocument xDoc;
      if (Context is DbContext) {
        xDoc = GetCsdlFromDbContext(Context);
      } else {
        xDoc = GetCsdlFromObjectContext(Context);
      }
      var jsonText = CsdlToJson(xDoc);

      /* Original version
      var jsonText = JsonConvert.SerializeXmlNode(doc);
      */
      return jsonText;
    }

    protected override EntityInfo CreateEntityInfo() {
      return new EFEntityInfo();
    }

    protected override List<KeyMapping> SaveChangesCore(Dictionary<Type, List<EntityInfo>> saveMap) {
      var deletedEntities = ProcessSaves(saveMap);

      if (deletedEntities.Any()) {
        ProcessAllDeleted(deletedEntities);
      }
      ProcessAutogeneratedKeys();

      int count;
      try {
        if (Context is DbContext) {
          count = ((DbContext)(object)Context).SaveChanges();
        } else {
          count = ObjectContext.SaveChanges(System.Data.Objects.SaveOptions.AcceptAllChangesAfterSave);
        }
      } catch (DbEntityValidationException e) {
        var msg = "";
        foreach (var eve in e.EntityValidationErrors) {
          var key = ObjectContext.ObjectStateManager.GetObjectStateEntry(eve.Entry.Entity).EntityKey;
          var formattedKey = key.EntitySetName + ";" +
                             key.EntityKeyValues.Select(v => v.ToString()).ToAggregateString(" ,");
          msg += String.Format("\n'{0}' has the following validation errors:", formattedKey);
          foreach (var ve in eve.ValidationErrors) {
            msg += String.Format("\n    Property: '{0}', Error: '{1}'",
                              ve.PropertyName, ve.ErrorMessage);
          }
        }
        throw new ValidationException(msg);
      }
      
      return UpdateAutoGeneratedKeys();
    }

    #endregion

    #region Save related methods

    private List<EFEntityInfo> ProcessSaves(Dictionary<Type, List<EntityInfo>> saveMap) {
      var deletedEntities = new List<EFEntityInfo>();
      foreach (var kvp in saveMap) {
        var entityType = kvp.Key;
        var entitySetName = GetEntitySetName(ObjectContext, entityType);
        foreach (EFEntityInfo entityInfo in kvp.Value) {
          entityInfo.EntitySetName = entitySetName;
          ProcessEntity(entityInfo);
          if (entityInfo.EntityState == EntityState.Deleted) {
            deletedEntities.Add(entityInfo);
          }
        }
      }
      return deletedEntities;
    }

    private void ProcessAllDeleted(List<EFEntityInfo> deletedEntities) {
      deletedEntities.ForEach(entityInfo => {

        RestoreOriginal(entityInfo);
        var entry = GetOrAddObjectStateEntry(entityInfo);
        entry.ChangeState(System.Data.EntityState.Deleted);
        entityInfo.ObjectStateEntry = entry;
      });
    }

    private void ProcessAutogeneratedKeys() {
      var tempKeys = EntitiesWithAutoGeneratedKeys.Cast<EFEntityInfo>().Where(
        entityInfo => entityInfo.AutoGeneratedKey.AutoGeneratedKeyType == AutoGeneratedKeyType.KeyGenerator)
        .Select(ei => new TempKeyInfo(ei))
        .ToList();
      if (tempKeys.Count == 0) return;
      if (this.KeyGenerator == null) {
        this.KeyGenerator = GetKeyGenerator();
      }
      this.KeyGenerator.UpdateKeys(tempKeys);
      tempKeys.ForEach(tki => {
        // Clever hack - next 3 lines cause all entities related to tki.Entity to have 
        // their relationships updated. So all related entities for each tki are updated.
        // Basically we set the entity to look like a preexisting entity by setting its
        // entityState to unchanged.  This is what fixes up the relations, then we set it back to added
        // Now when we update the pk - all fks will get changed as well.  Note that the fk change will only
        // occur during the save.
        var entry = GetObjectStateEntry(tki.Entity);
        entry.ChangeState(System.Data.EntityState.Unchanged);
        entry.ChangeState(System.Data.EntityState.Added);
        var val = ConvertValue(tki.RealValue, tki.Property.PropertyType);
        tki.Property.SetValue(tki.Entity, val, null);
      });
    }

    private IKeyGenerator GetKeyGenerator() {
      var generatorType = KeyGeneratorType.Value;
      return (IKeyGenerator)Activator.CreateInstance(generatorType, DbConnection);
    }

    private EntityInfo ProcessEntity(EFEntityInfo entityInfo) {
      ObjectStateEntry ose;
      if (entityInfo.EntityState == EntityState.Modified) {
        ose = HandleModified(entityInfo);
      } else if (entityInfo.EntityState == EntityState.Added) {
        ose = HandleAdded(entityInfo);
      } else if (entityInfo.EntityState == EntityState.Deleted) {
        // for 1st pass this does NOTHING 
        ose = HandleDeletedPart1(entityInfo);
      } else {
        // needed for many to many to get both ends into the objectContext
        ose = HandleUnchanged(entityInfo);
      }
      entityInfo.ObjectStateEntry = ose;
      return entityInfo;
    }

    private ObjectStateEntry HandleAdded(EFEntityInfo entityInfo) {
      var entry = AddObjectStateEntry(entityInfo);
      if (entityInfo.AutoGeneratedKey != null) {
        entityInfo.AutoGeneratedKey.TempValue = GetOsePropertyValue(entry, entityInfo.AutoGeneratedKey.PropertyName);
      }
      entry.ChangeState(System.Data.EntityState.Added);
      return entry;
    }

    private ObjectStateEntry HandleModified(EFEntityInfo entityInfo) {
      var entry = AddObjectStateEntry(entityInfo);
      // EntityState will be changed to modified during the update from the OriginalValuesMap
      // Do NOT change this to EntityState.Modified because this will cause the entire record to update.
      entry.ChangeState(System.Data.EntityState.Unchanged);

      // updating the original values is necessary under certain conditions when we change a foreign key field
      // because the before value is used to determine ordering.
      UpdateOriginalValues(entry, entityInfo);

      //foreach (var dep in GetModifiedComplexTypeProperties(entity, metadata)) {
      //  entry.SetModifiedProperty(dep.Name);
      //}
      
      if ((int) entry.State != (int) EntityState.Modified) {
        // _originalValusMap can be null if we mark entity.SetModified but don't actually change anything.
        entry.ChangeState(System.Data.EntityState.Modified);
      }
      return entry;
    }

    private ObjectStateEntry HandleUnchanged(EFEntityInfo entityInfo) {
      var entry = AddObjectStateEntry(entityInfo);
      entry.ChangeState(System.Data.EntityState.Unchanged);
      return entry;
    }

    private ObjectStateEntry HandleDeletedPart1(EntityInfo entityInfo) {
      return null;
    }

    private EntityInfo RestoreOriginal(EntityInfo entityInfo) {
      // fk's can get cleared depending on the order in which deletions occur -
      // EF needs the original values of these fk's under certain circumstances - ( not sure entirely what these are). 
      // so we restore the original fk values right before we attach the entity 
      // shouldn't be any side effects because we delete it immediately after.
      // concurrency values also need to be restored in some cases. 
      // This method restores more than it actually needs to because we don't
      // have metadata easily avail here, but usually a deleted entity will
      // not have much in the way of OriginalValues.
      if (entityInfo.OriginalValuesMap == null || entityInfo.OriginalValuesMap.Keys.Count == 0) {
        return entityInfo;
      }
      var entity = entityInfo.Entity;
      
      entityInfo.OriginalValuesMap.ToList().ForEach(kvp => {
        SetPropertyValue(entity, kvp.Key, kvp.Value);
      });

      return entityInfo;
    }

    private static void UpdateOriginalValues(ObjectStateEntry entry, EntityInfo entityInfo) {
      var originalValuesMap = entityInfo.OriginalValuesMap;
      if (originalValuesMap == null || originalValuesMap.Keys.Count == 0) return;

      var originalValuesRecord = entry.GetUpdatableOriginalValues();
      originalValuesMap.ToList().ForEach(kvp => {
        var propertyName = kvp.Key;
        var originalValue = kvp.Value;

        try {
          entry.SetModifiedProperty(propertyName);
          if (originalValue is JObject) {
            // only really need to perform updating original values on key properties
            // and a complex object cannot be a key.
          } else {
            var ordinal = originalValuesRecord.GetOrdinal(propertyName);
            var fieldType = originalValuesRecord.GetFieldType(ordinal);
            var originalValueConverted = ConvertValue(originalValue, fieldType);

            if (originalValueConverted == null) {
              // bug - hack because of bug in EF - see 
              // http://social.msdn.microsoft.com/Forums/nl/adodotnetentityframework/thread/cba1c425-bf82-4182-8dfb-f8da0572e5da
              var temp = entry.CurrentValues[ordinal];
              entry.CurrentValues.SetDBNull(ordinal);
              entry.ApplyOriginalValues(entry.Entity);
              entry.CurrentValues.SetValue(ordinal, temp);
            } else {
              originalValuesRecord.SetValue(ordinal, originalValueConverted);
            }
          }
        } catch (Exception e) {
          // this can happen for "custom" data entity properties.
        }
      });

    }

    private List<KeyMapping> UpdateAutoGeneratedKeys() {
      // where clause is necessary in case the Entities were suppressed in the beforeSave event.
      var keyMappings = EntitiesWithAutoGeneratedKeys.Cast<EFEntityInfo>()
        .Where(entityInfo => entityInfo.ObjectStateEntry != null)
        .Select(entityInfo => {
        var autoGeneratedKey = entityInfo.AutoGeneratedKey;
        if (autoGeneratedKey.AutoGeneratedKeyType == AutoGeneratedKeyType.Identity) {
          autoGeneratedKey.RealValue = GetOsePropertyValue(entityInfo.ObjectStateEntry, autoGeneratedKey.PropertyName);
        }
        return new KeyMapping() {
          EntityTypeName = entityInfo.Entity.GetType().FullName,
          TempValue = autoGeneratedKey.TempValue,
          RealValue = autoGeneratedKey.RealValue
        };
      });
      return keyMappings.ToList();
    }

    private Object GetOsePropertyValue(ObjectStateEntry ose, String propertyName) {
      var currentValues = ose.CurrentValues;
      var ix = currentValues.GetOrdinal(propertyName);
      return currentValues[ix];
    }

    private void SetOsePropertyValue(ObjectStateEntry ose, String propertyName, Object value) {
      var currentValues = ose.CurrentValues;
      var ix = currentValues.GetOrdinal(propertyName);
      currentValues.SetValue(ix, value);
    }

    private void SetPropertyValue(Object entity, String propertyName, Object value) {
      var propInfo = entity.GetType().GetProperty(propertyName,
                                                  BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
      if (propInfo.CanWrite) {
        var val = ConvertValue(value, propInfo.PropertyType);
        propInfo.SetValue(entity, val, null);
      } else {
        throw new Exception(String.Format("Unable to write to property '{0}' on type: '{1}'", propertyName,
                                          entity.GetType()));
      }
    }

    private static Object ConvertValue(Object val, Type toType) {
      Object result;
      // TODO: handle nullables
      if (val == null) return val;
      if (toType == val.GetType()) return val;
      
      if (typeof (IConvertible).IsAssignableFrom(toType)) {
        result = Convert.ChangeType(val, toType, System.Threading.Thread.CurrentThread.CurrentCulture);
      } else if (val is JObject) {
        var serializer = new JsonSerializer();
        result = serializer.Deserialize(new JTokenReader((JObject) val), toType);
      } else {
        // Guids fail above - try this
        TypeConverter typeConverter = TypeDescriptor.GetConverter(toType);
        result = typeConverter.ConvertFrom(val);
      }
      return result;
    }
  
    private ObjectStateEntry GetOrAddObjectStateEntry(EFEntityInfo entityInfo) {
      ObjectStateEntry entry;
      if (ObjectContext.ObjectStateManager.TryGetObjectStateEntry(entityInfo.Entity, out entry)) return entry;

      return AddObjectStateEntry(entityInfo);
    }

    private ObjectStateEntry AddObjectStateEntry( EFEntityInfo entityInfo) {
      ObjectContext.AddObject(entityInfo.EntitySetName, entityInfo.Entity);
      // Attach has lots of side effect - add has far fewer.
      return GetObjectStateEntry(entityInfo);
    }

    private ObjectStateEntry AttachObjectStateEntry( EFEntityInfo entityInfo) {
      ObjectContext.AttachTo(entityInfo.EntitySetName, entityInfo.Entity);
      // Attach has lots of side effect - add has far fewer.
      return GetObjectStateEntry(entityInfo);
    }

    private ObjectStateEntry GetObjectStateEntry( EFEntityInfo entityInfo) {
      return GetObjectStateEntry(entityInfo.Entity);
    }

    private ObjectStateEntry GetObjectStateEntry(Object entity) {
      ObjectStateEntry entry;
      if (!ObjectContext.ObjectStateManager.TryGetObjectStateEntry(entity, out entry)) {
        throw new Exception("unable to add to context: " + entity);
      }
      return entry;
    }
    

    #endregion

    #region Metadata methods

    protected XDocument GetCsdlFromDbContext(Object context) {
      var dbContext = (DbContext) context;
      XElement xele;

      try {
        using (var swriter = new StringWriter()) {
          using (var xwriter = new XmlTextWriter(swriter)) {
            EdmxWriter.WriteEdmx(dbContext, xwriter);
            xele = XElement.Parse(swriter.ToString());
          }
        }
      } catch (Exception e) {
        if (e is NotSupportedException) {
          // DbContext that fails on WriteEdmx is likely a DataBase first DbContext.
          return GetCsdlFromObjectContext(dbContext);
        } else {
          throw;
        }
      }
     
      var ns = xele.Name.Namespace;
      var conceptualEle = xele.Descendants(ns + "ConceptualModels").First();
      var schemaEle = conceptualEle.Elements().First(ele => ele.Name.LocalName == "Schema");
      var xDoc = XDocument.Load(schemaEle.CreateReader());

      // This is needed because the raw edmx has a different namespace than the CLR types that it references.
      var objectContext = ((IObjectContextAdapter)dbContext).ObjectContext;
      AddCSpaceOSpaceMapping(xDoc, objectContext);

      return xDoc;
    }

    protected XDocument GetCsdlFromObjectContext(Object context) {

      var ocAssembly = context.GetType().Assembly;
      var ocNamespace = context.GetType().Namespace;
      ObjectContext objectContext;
      if (context is DbContext) {
        var dbContext = (DbContext) context;
        objectContext = ((IObjectContextAdapter) dbContext).ObjectContext;
      } else {
        objectContext = (ObjectContext) context;
      }
      
      var ec = objectContext.Connection as EntityConnection;
      
      if (ec == null) {
        throw new Exception("Unable to create an EntityConnection for this ObjectContext");
      } 
      var ecBuilder = new EntityConnectionStringBuilder(ec.ConnectionString);
      var metadataString = "";
      if (!String.IsNullOrEmpty(ecBuilder.Name)) {
        metadataString = GetConnectionStringFromConfig(ecBuilder.Name);
      } else if (!String.IsNullOrEmpty(ecBuilder.Metadata)) {
        metadataString = ecBuilder.Metadata;
      } else {
        throw new Exception("Unable to locate EDMX metadata for " + ec.ConnectionString);
      }
      
      var csdlResource = metadataString.Split('|', ';', '=')
        .FirstOrDefault(s => {
          s = s.Trim();
          return s.StartsWith(ResourcePrefix) && s.EndsWith(".csdl");
        });
      if (csdlResource == null) {
        throw new Exception("Unable to locate a 'csdl' resource within this connection:" + ec.ConnectionString);
      }

      var parts = csdlResource.Split('/', '.');
      var normalizedResourceName = String.Join(".", parts.Skip(parts.Length - 2));
      var resourceNames = ocAssembly.GetManifestResourceNames();
      var manifestResourceName = resourceNames
        .FirstOrDefault(n => n.EndsWith(normalizedResourceName));
      if (manifestResourceName == null) {
        manifestResourceName = resourceNames.FirstOrDefault(n => 
          n == "System.Data.Resources.DbProviderServices.ConceptualSchemaDefinition.csdl"
        );
        if (manifestResourceName == null) {
          throw new Exception("Unable to locate an embedded resource with the name " +
                              "'System.Data.Resources.DbProviderServices.ConceptualSchemaDefinition.csdl'" +
                              " or a resource that ends with: " + normalizedResourceName);
        }
      }
      XDocument xDoc;
      using (var mmxStream = ocAssembly.GetManifestResourceStream(manifestResourceName)) {
        xDoc = XDocument.Load(mmxStream);
      }
      // This is needed because the raw edmx has a different namespace than the CLR types that it references.
      AddCSpaceOSpaceMapping(xDoc, objectContext);
      return xDoc;
    }

    private void AddCSpaceOSpaceMapping(XDocument xDoc, ObjectContext oc) {
      var tpls = GetCSpaceOSpaceMapping(oc);
      var ocMapping = JsonConvert.SerializeObject(tpls);
      xDoc.Root.SetAttributeValue("CSpaceOSpaceMapping", ocMapping);
    }
  
    private List<String[]> GetCSpaceOSpaceMapping(ObjectContext oc) {
      var metadataWs = oc.MetadataWorkspace;
      var cspaceTypes = metadataWs.GetItems<StructuralType>(DataSpace.CSpace);
      ForceOSpaceLoad(oc);
      var tpls = cspaceTypes
          .Where(st => !(st is AssociationType))
          .Select(st => {
            var ost = metadataWs.GetObjectSpaceType(st);
            return new [] {st.FullName, ost.FullName};
          })
          .ToList();
      return tpls;
    }

    private void ForceOSpaceLoad(ObjectContext oc) {
      var metadataWs = oc.MetadataWorkspace;
      var asm = oc.GetType().Assembly;
      metadataWs.LoadFromAssembly(asm);
    }

    private String CsdlToJson(XDocument xDoc) {

      var sw = new StringWriter();
      using (var jsonWriter = new JsonPropertyFixupWriter(sw)) {
        // jsonWriter.Formatting = Newtonsoft.Json.Formatting.Indented;
        var jsonSerializer = new JsonSerializer();
        var converter = new XmlNodeConverter();
        // May need to put this back.
        // converter.OmitRootObject = true;
        // doesn't seem to do anything.
        // converter.WriteArrayAttribute = true;
        jsonSerializer.Converters.Add(converter);
        jsonSerializer.Serialize(jsonWriter, xDoc);
      }

      var jsonText = sw.ToString();
      return jsonText;
    }

    protected String GetConnectionStringFromConfig(String connectionName) {
      var item = ConfigurationManager.ConnectionStrings[connectionName];
      return item.ConnectionString;
    }

    #endregion

    private String GetEntitySetName(ObjectContext context, Type entityType) {
      var typeName = entityType.Name;
      var container = context.MetadataWorkspace.GetEntityContainer(context.DefaultContainerName, DataSpace.CSpace);
      var entitySetName = container.BaseEntitySets
        .Where(es => es.ElementType.Name == typeName)
        .Select(es => es.Name)
        .First();
      return entitySetName;
    }

    private const string ResourcePrefix = @"res://";
    
    private T _context;
  }

  
  public class EFEntityInfo : EntityInfo {
    internal EFEntityInfo() {
    }

    internal String EntitySetName ;
    internal ObjectStateEntry ObjectStateEntry;
  }
  
}