(function(undefined) {
  // The Opal object that is exposed globally
  var Opal = this.Opal = {};

  // The actual class for BasicObject
  var RubyBasicObject;

  // The actual Object class
  var RubyObject;

  // The actual Module class
  var RubyModule;

  // The actual Class class
  var RubyClass;

  // Constructor for instances of BasicObject
  function BasicObject(){}

  // Constructor for instances of Object
  function Object(){}

  // Constructor for instances of Class
  function Class(){}

  // Constructor for instances of Module
  function Module(){}

  // Constructor for instances of NilClass (nil)
  function NilClass(){}

  // All bridged classes - keep track to donate methods from Object
  var bridged_classes = [];

  // TopScope is used for inheriting constants from the top scope
  var TopScope = function(){};

  // Opal just acts as the top scope
  TopScope.prototype = Opal;

  // To inherit scopes
  Opal.constructor  = TopScope;

  Opal.constants = [];

  // This is a useful reference to global object inside ruby files
  Opal.global = this;

  // Minify common function calls
  var $hasOwn = Opal.hasOwnProperty;
  var $slice  = Opal.slice = Array.prototype.slice;

  // Generates unique id for every ruby object
  var unique_id = 0;

  // Return next unique id
  Opal.uid = function() {
    return unique_id++;
  };

  // Table holds all class variables
  Opal.cvars = {};

  // Globals table
  Opal.gvars = {};

  /*
   * Create a new constants scope for the given class with the given
   * base. Constants are looked up through their parents, so the base
   * scope will be the outer scope of the new klass.
   */
  function create_scope(base, klass, id) {
    var const_alloc   = function() {};
    var const_scope   = const_alloc.prototype = new base.constructor();
    klass._scope      = const_scope;
    const_scope.base  = klass;
    klass._base_module = base.base;
    const_scope.constructor = const_alloc;
    const_scope.constants = [];

    if (id) {
      klass._orig_scope = base;
      base[id] = base.constructor[id] = klass;
      base.constants.push(id);
    }
  }

  Opal.create_scope = create_scope;

  /*
   * A `class Foo; end` expression in ruby is compiled to call this runtime
   * method which either returns an existing class of the given name, or creates
   * a new class in the given `base` scope.
   *
   * If a constant with the given name exists, then we check to make sure that
   * it is a class and also that the superclasses match. If either of these
   * fail, then we raise a `TypeError`. Note, superklass may be null if one was
   * not specified in the ruby code.
   *
   * We pass a constructor to this method of the form `function ClassName() {}`
   * simply so that classes show up with nicely formatted names inside debuggers
   * in the web browser (or node/sprockets).
   *
   * The `base` is the current `self` value where the class is being created
   * from. We use this to get the scope for where the class should be created.
   * If `base` is an object (not a class/module), we simple get its class and
   * use that as the base instead.
   *
   * @param [Object] base where the class is being created
   * @param [Class] superklass superclass of the new class (may be null)
   * @param [String] id the name of the class to be created
   * @param [Function] constructor function to use as constructor
   * @return [Class] new or existing ruby class
   */
  Opal.klass = function(base, superklass, id, constructor) {

    // If base is an object, use its class
    if (!base._isClass) {
      base = base._klass;
    }

    // Not specifying a superclass means we can assume it to be Object
    if (superklass === null) {
      superklass = RubyObject;
    }

    var klass = base._scope[id];

    // If a constant exists in the scope, then we must use that
    if ($hasOwn.call(base._scope, id) && klass._orig_scope === base._scope) {

      // Make sure the existing constant is a class, or raise error
      if (!klass._isClass) {
        throw Opal.TypeError.$new(id + " is not a class");
      }

      // Make sure existing class has same superclass
      if (superklass !== klass._super && superklass !== RubyObject) {
        throw Opal.TypeError.$new("superclass mismatch for class " + id);
      }
    }
    else if (typeof(superklass) === 'function') {
      // passed native constructor as superklass, so bridge it as ruby class
      return bridge_class(id, superklass);
    }
    else {
      // if class doesnt exist, create a new one with given superclass
      klass = boot_class(superklass, constructor);

      // name class using base (e.g. Foo or Foo::Baz)
      klass._name = id;

      // every class gets its own constant scope, inherited from current scope
      create_scope(base._scope, klass, id);

      // Name new class directly onto current scope (Opal.Foo.Baz = klass)
      base[id] = base._scope[id] = klass;

      // Copy all parent constants to child, unless parent is Object
      if (superklass !== RubyObject && superklass !== RubyBasicObject) {
        Opal.donate_constants(superklass, klass);
      }

      // call .inherited() hook with new class on the superclass
      if (superklass.$inherited) {
        superklass.$inherited(klass);
      }
    }

    return klass;
  };

  // Create generic class with given superclass.
  var boot_class = Opal.boot = function(superklass, constructor) {
    // instances
    var ctor = function() {};
        ctor.prototype = superklass._proto;

    constructor.prototype = new ctor();

    constructor.prototype.constructor = constructor;

    return boot_class_meta(superklass, constructor);
  };

  // class itself
  function boot_class_meta(superklass, constructor) {
    var mtor = function() {};
    mtor.prototype = superklass.constructor.prototype;

    function OpalClass() {};
    OpalClass.prototype = new mtor();

    var klass = new OpalClass();

    klass._id         = unique_id++;
    klass._alloc      = constructor;
    klass._isClass    = true;
    klass.constructor = OpalClass;
    klass._super      = superklass;
    klass._methods    = [];
    klass.__inc__     = [];
    klass.__parent    = superklass;
    klass._proto      = constructor.prototype;

    constructor.prototype._klass = klass;

    return klass;
  }

  // Define new module (or return existing module)
  Opal.module = function(base, id) {
    var module;

    if (!base._isClass) {
      base = base._klass;
    }

    if ($hasOwn.call(base._scope, id)) {
      module = base._scope[id];

      if (!module.__mod__ && module !== RubyObject) {
        throw Opal.TypeError.$new(id + " is not a module")
      }
    }
    else {
      module = boot_module()
      module._name = id;

      create_scope(base._scope, module, id);

      // Name new module directly onto current scope (Opal.Foo.Baz = module)
      base[id] = base._scope[id] = module;
    }

    return module;
  };

  /*
   * Internal function to create a new module instance. This simply sets up
   * the prototype hierarchy and method tables.
   */
  function boot_module() {
    var mtor = function() {};
    mtor.prototype = RubyModule.constructor.prototype;

    function OpalModule() {};
    OpalModule.prototype = new mtor();

    var module = new OpalModule();

    module._id         = unique_id++;
    module._isClass    = true;
    module.constructor = OpalModule;
    module._super      = RubyModule;
    module._methods    = [];
    module.__inc__     = [];
    module.__parent    = RubyModule;
    module._proto      = {};
    module.__mod__     = true;
    module.__dep__     = [];

    return module;
  }

  // Boot a base class (makes instances).
  var boot_defclass = function(id, constructor, superklass) {
    if (superklass) {
      var ctor           = function() {};
          ctor.prototype = superklass.prototype;

      constructor.prototype = new ctor();
    }

    constructor.prototype.constructor = constructor;

    return constructor;
  };

  // Boot the actual (meta?) classes of core classes
  var boot_makemeta = function(id, constructor, superklass) {

    var mtor = function() {};
    mtor.prototype  = superklass.prototype;

    function OpalClass() {};
    OpalClass.prototype = new mtor();

    var klass = new OpalClass();

    klass._id         = unique_id++;
    klass._alloc      = constructor;
    klass._isClass    = true;
    klass._name       = id;
    klass._super      = superklass;
    klass.constructor = OpalClass;
    klass._methods    = [];
    klass.__inc__     = [];
    klass.__parent    = superklass;
    klass._proto      = constructor.prototype;

    constructor.prototype._klass = klass;

    Opal[id] = klass;
    Opal.constants.push(id);

    return klass;
  };

  /*
   * For performance, some core ruby classes are toll-free bridged to their
   * native javascript counterparts (e.g. a ruby Array is a javascript Array).
   *
   * This method is used to setup a native constructor (e.g. Array), to have
   * its prototype act like a normal ruby class. Firstly, a new ruby class is
   * created using the native constructor so that its prototype is set as the
   * target for th new class. Note: all bridged classes are set to inherit
   * from Object.
   *
   * Bridged classes are tracked in `bridged_classes` array so that methods
   * defined on Object can be "donated" to all bridged classes. This allows
   * us to fake the inheritance of a native prototype from our Object
   * prototype.
   *
   * Example:
   *
   *    bridge_class("Proc", Function);
   *
   * @param [String] name the name of the ruby class to create
   * @param [Function] constructor native javascript constructor to use
   * @return [Class] returns new ruby class
   */
  function bridge_class(name, constructor) {
    var klass = boot_class_meta(RubyObject, constructor);

    klass._name = name;

    create_scope(Opal, klass, name);
    bridged_classes.push(klass);

    var object_methods = RubyBasicObject._methods.concat(RubyObject._methods);

    for (var i = 0, len = object_methods.length; i < len; i++) {
      var meth = object_methods[i];
      constructor.prototype[meth] = RubyObject._proto[meth];
    }

    return klass;
  };

  /*
   * constant assign
   */
  Opal.casgn = function(base_module, name, value) {
    var scope = base_module._scope;

    if (value._isClass && value._name === nil) {
      value._name = name;
    }

    if (value._isClass) {
      value._base_module = base_module;
    }

    scope.constants.push(name);
    return scope[name] = value;
  };

  /*
   * constant decl
   */
  Opal.cdecl = function(base_scope, name, value) {
    base_scope.constants.push(name);
    return base_scope[name] = value;
  };

  /*
   * constant get
   */
  Opal.cget = function(base_scope, path) {
    if (path == null) {
      path       = base_scope;
      base_scope = Opal.Object;
    }

    var result = base_scope;

    path = path.split('::');
    while (path.length != 0) {
      result = result.$const_get(path.shift());
    }

    return result;
  }

  /*
   * When a source module is included into the target module, we must also copy
   * its constants to the target.
   */
  Opal.donate_constants = function(source_mod, target_mod) {
    var source_constants = source_mod._scope.constants,
        target_scope     = target_mod._scope,
        target_constants = target_scope.constants;

    for (var i = 0, length = source_constants.length; i < length; i++) {
      target_constants.push(source_constants[i]);
      target_scope[source_constants[i]] = source_mod._scope[source_constants[i]];
    }
  };

  /*
   * Methods stubs are used to facilitate method_missing in opal. A stub is a
   * placeholder function which just calls `method_missing` on the receiver.
   * If no method with the given name is actually defined on an object, then it
   * is obvious to say that the stub will be called instead, and then in turn
   * method_missing will be called.
   *
   * When a file in ruby gets compiled to javascript, it includes a call to
   * this function which adds stubs for every method name in the compiled file.
   * It should then be safe to assume that method_missing will work for any
   * method call detected.
   *
   * Method stubs are added to the BasicObject prototype, which every other
   * ruby object inherits, so all objects should handle method missing. A stub
   * is only added if the given property name (method name) is not already
   * defined.
   *
   * Note: all ruby methods have a `$` prefix in javascript, so all stubs will
   * have this prefix as well (to make this method more performant).
   *
   *    Opal.add_stubs(["$foo", "$bar", "$baz="]);
   *
   * All stub functions will have a private `rb_stub` property set to true so
   * that other internal methods can detect if a method is just a stub or not.
   * `Kernel#respond_to?` uses this property to detect a methods presence.
   *
   * @param [Array] stubs an array of method stubs to add
   */
  Opal.add_stubs = function(stubs) {
    for (var i = 0, length = stubs.length; i < length; i++) {
      var stub = stubs[i];

      if (!BasicObject.prototype[stub]) {
        BasicObject.prototype[stub] = true;
        add_stub_for(BasicObject.prototype, stub);
      }
    }
  };

  /*
   * Actuall add a method_missing stub function to the given prototype for the
   * given name.
   *
   * @param [Prototype] prototype the target prototype
   * @param [String] stub stub name to add (e.g. "$foo")
   */
  function add_stub_for(prototype, stub) {
    function method_missing_stub() {
      // Copy any given block onto the method_missing dispatcher
      this.$method_missing._p = method_missing_stub._p;

      // Set block property to null ready for the next call (stop false-positives)
      method_missing_stub._p = null;

      // call method missing with correct args (remove '$' prefix on method name)
      return this.$method_missing.apply(this, [stub.slice(1)].concat($slice.call(arguments)));
    }

    method_missing_stub.rb_stub = true;
    prototype[stub] = method_missing_stub;
  }

  // Expose for other parts of Opal to use
  Opal.add_stub_for = add_stub_for;

  // Const missing dispatcher
  Opal.cm = function(name) {
    return this.base.$const_missing(name);
  };

  // Arity count error dispatcher
  Opal.ac = function(actual, expected, object, meth) {
    var inspect = (object._isClass ? object._name + '.' : object._klass._name + '#') + meth;
    var msg = '[' + inspect + '] wrong number of arguments(' + actual + ' for ' + expected + ')';
    throw Opal.ArgumentError.$new(msg);
  };

  // Super dispatcher
  Opal.find_super_dispatcher = function(obj, jsid, current_func, iter, defs) {
    var dispatcher;

    if (defs) {
      dispatcher = obj._isClass ? defs._super : obj._klass._proto;
    }
    else {
      if (obj._isClass) {
        dispatcher = obj._super;
      }
      else {
        dispatcher = find_obj_super_dispatcher(obj, jsid, current_func);
      }
    }

    dispatcher = dispatcher['$' + jsid];
    dispatcher._p = iter;

    return dispatcher;
  };

  // Iter dispatcher for super in a block
  Opal.find_iter_super_dispatcher = function(obj, jsid, current_func, iter, defs) {
    if (current_func._def) {
      return Opal.find_super_dispatcher(obj, current_func._jsid, current_func, iter, defs);
    }
    else {
      return Opal.find_super_dispatcher(obj, jsid, current_func, iter, defs);
    }
  };

  var find_obj_super_dispatcher = function(obj, jsid, current_func) {
    var klass = obj.__meta__ || obj._klass;

    while (klass) {
      if (klass._proto['$' + jsid] === current_func) {
        // ok
        break;
      }

      klass = klass.__parent;
    }

    // if we arent in a class, we couldnt find current?
    if (!klass) {
      throw new Error("could not find current class for super()");
    }

    klass = klass.__parent;

    // else, let's find the next one
    while (klass) {
      var working = klass._proto['$' + jsid];

      if (working && working !== current_func) {
        // ok
        break;
      }

      klass = klass.__parent;
    }

    return klass._proto;
  };

  /*
   * Used to return as an expression. Sometimes, we can't simply return from
   * a javascript function as if we were a method, as the return is used as
   * an expression, or even inside a block which must "return" to the outer
   * method. This helper simply throws an error which is then caught by the
   * method. This approach is expensive, so it is only used when absolutely
   * needed.
   */
  Opal.$return = function(val) {
    Opal.returner.$v = val;
    throw Opal.returner;
  };

  // handles yield calls for 1 yielded arg
  Opal.$yield1 = function(block, arg) {
    if (typeof(block) !== "function") {
      throw Opal.LocalJumpError.$new("no block given");
    }

    if (block.length > 1) {
      if (arg._isArray) {
        return block.apply(null, arg);
      }
      else {
        return block(arg);
      }
    }
    else {
      return block(arg);
    }
  };

  // handles yield for > 1 yielded arg
  Opal.$yieldX = function(block, args) {
    if (typeof(block) !== "function") {
      throw Opal.LocalJumpError.$new("no block given");
    }

    if (block.length > 1 && args.length == 1) {
      if (args[0]._isArray) {
        return block.apply(null, args[0]);
      }
    }

    if (!args._isArray) {
      args = $slice.call(args);
    }

    return block.apply(null, args);
  };

  // Finds the corresponding exception match in candidates.  Each candidate can
  // be a value, or an array of values.  Returns null if not found.
  Opal.$rescue = function(exception, candidates) {
    for (var i = 0; i != candidates.length; i++) {
      var candidate = candidates[i];
      if (candidate._isArray) {
        var subresult;
        if (subresult = Opal.$rescue(exception, candidate)) {
          return subresult;
        }
      }
      else if (candidate['$==='](exception)) {
        return candidate;
      }
    }
    return null;
  };

  Opal.is_a = function(object, klass) {
    if (object.__meta__ === klass) {
      return true;
    }

    var search = object._klass;

    while (search) {
      if (search === klass) {
        return true;
      }

      for (var i = 0, length = search.__inc__.length; i < length; i++) {
        if (search.__inc__[i] == klass) {
          return true;
        }
      }

      search = search._super;
    }

    return false;
  }

  // Helper to convert the given object to an array
  Opal.to_ary = function(value) {
    if (value._isArray) {
      return value;
    }
    else if (value.$to_ary && !value.$to_ary.rb_stub) {
      return value.$to_ary();
    }

    return [value];
  };

  /*
    Call a ruby method on a ruby object with some arguments:

      var my_array = [1, 2, 3, 4]
      Opal.send(my_array, 'length')     # => 4
      Opal.send(my_array, 'reverse!')   # => [4, 3, 2, 1]

    A missing method will be forwarded to the object via
    method_missing.

    The result of either call with be returned.

    @param [Object] recv the ruby object
    @param [String] mid ruby method to call
  */
  Opal.send = function(recv, mid) {
    var args = $slice.call(arguments, 2),
        func = recv['$' + mid];

    if (func) {
      return func.apply(recv, args);
    }

    return recv.$method_missing.apply(recv, [mid].concat(args));
  };

  Opal.block_send = function(recv, mid, block) {
    var args = $slice.call(arguments, 3),
        func = recv['$' + mid];

    if (func) {
      func._p = block;
      return func.apply(recv, args);
    }

    return recv.$method_missing.apply(recv, [mid].concat(args));
  };

  /**
   * Donate methods for a class/module
   */
  Opal.donate = function(klass, defined, indirect) {
    var methods = klass._methods, included_in = klass.__dep__;

    // if (!indirect) {
      klass._methods = methods.concat(defined);
    // }

    if (included_in) {
      for (var i = 0, length = included_in.length; i < length; i++) {
        var includee = included_in[i];
        var dest = includee._proto;

        for (var j = 0, jj = defined.length; j < jj; j++) {
          var method = defined[j];
          dest[method] = klass._proto[method];
          dest[method]._donated = true;
        }

        if (includee.__dep__) {
          Opal.donate(includee, defined, true);
        }
      }
    }
  };

  Opal.defn = function(obj, jsid, body) {
    if (obj.__mod__) {
      obj._proto[jsid] = body;
      Opal.donate(obj, [jsid]);
    }
    else if (obj._isClass) {
      obj._proto[jsid] = body;

      if (obj === RubyBasicObject) {
        define_basic_object_method(jsid, body);
      }
      else if (obj === RubyObject) {
        Opal.donate(obj, [jsid]);
      }
    }
    else {
      obj[jsid] = body;
    }

    return nil;
  };

  /*
   * Define a singleton method on the given object.
   */
  Opal.defs = function(obj, jsid, body) {
    if (obj._isClass || obj.__mod__) {
      obj.constructor.prototype[jsid] = body;
    }
    else {
      obj[jsid] = body;
    }
  };

  function define_basic_object_method(jsid, body) {
    RubyBasicObject._methods.push(jsid);
    for (var i = 0, len = bridged_classes.length; i < len; i++) {
      bridged_classes[i]._proto[jsid] = body;
    }
  }

  Opal.hash = function() {
    if (arguments.length == 1 && arguments[0]._klass == Opal.Hash) {
      return arguments[0];
    }

    var hash   = new Opal.Hash._alloc,
        keys   = [],
        assocs = {};

    hash.map   = assocs;
    hash.keys  = keys;

    if (arguments.length == 1) {
      if (arguments[0]._isArray) {
        var args = arguments[0];

        for (var i = 0, length = args.length; i < length; i++) {
          var pair = args[i];

          if (pair.length !== 2) {
            throw Opal.ArgumentError.$new("value not of length 2: " + pair.$inspect());
          }

          var key = pair[0],
              obj = pair[1];

          if (assocs[key] == null) {
            keys.push(key);
          }

          assocs[key] = obj;
        }
      }
      else {
        var obj = arguments[0];
        for (var key in obj) {
          assocs[key] = obj[key];
          keys.push(key);
        }
      }
    }
    else {
      var length = arguments.length;
      if (length % 2 !== 0) {
        throw Opal.ArgumentError.$new("odd number of arguments for Hash");
      }

      for (var i = 0; i < length; i++) {
        var key = arguments[i],
            obj = arguments[++i];

        if (assocs[key] == null) {
          keys.push(key);
        }

        assocs[key] = obj;
      }
    }

    return hash;
  };

  /*
   * hash2 is a faster creator for hashes that just use symbols and
   * strings as keys. The map and keys array can be constructed at
   * compile time, so they are just added here by the constructor
   * function
   */
  Opal.hash2 = function(keys, map) {
    var hash = new Opal.Hash._alloc;

    hash.keys = keys;
    hash.map  = map;

    return hash;
  };

  /*
   * Create a new range instance with first and last values, and whether the
   * range excludes the last value.
   */
  Opal.range = function(first, last, exc) {
    var range         = new Opal.Range._alloc;
        range.begin   = first;
        range.end     = last;
        range.exclude = exc;

    return range;
  };

  // Initialization
  // --------------

  // Constructors for *instances* of core objects
  boot_defclass('BasicObject', BasicObject);
  boot_defclass('Object', Object, BasicObject);
  boot_defclass('Module', Module, Object);
  boot_defclass('Class', Class, Module);

  // Constructors for *classes* of core objects
  RubyBasicObject = boot_makemeta('BasicObject', BasicObject, Class);
  RubyObject      = boot_makemeta('Object', Object, RubyBasicObject.constructor);
  RubyModule      = boot_makemeta('Module', Module, RubyObject.constructor);
  RubyClass       = boot_makemeta('Class', Class, RubyModule.constructor);

  // Fix booted classes to use their metaclass
  RubyBasicObject._klass = RubyClass;
  RubyObject._klass = RubyClass;
  RubyModule._klass = RubyClass;
  RubyClass._klass = RubyClass;

  // Fix superclasses of booted classes
  RubyBasicObject._super = null;
  RubyObject._super = RubyBasicObject;
  RubyModule._super = RubyObject;
  RubyClass._super = RubyModule;

  // Internally, Object acts like a module as it is "included" into bridged
  // classes. In other words, we donate methods from Object into our bridged
  // classes as their prototypes don't inherit from our root Object, so they
  // act like module includes.
  RubyObject.__dep__ = bridged_classes;

  Opal.base = RubyObject;
  RubyBasicObject._scope = RubyObject._scope = Opal;
  RubyBasicObject._orig_scope = RubyObject._orig_scope = Opal;
  Opal.Kernel = RubyObject;

  RubyModule._scope = RubyObject._scope;
  RubyClass._scope = RubyObject._scope;
  RubyModule._orig_scope = RubyObject._orig_scope;
  RubyClass._orig_scope = RubyObject._orig_scope;

  RubyObject._proto.toString = function() {
    return this.$to_s();
  };

  Opal.top = new RubyObject._alloc();

  Opal.klass(RubyObject, RubyObject, 'NilClass', NilClass);

  var nil = Opal.nil = new NilClass;
  nil.call = nil.apply = function() { throw Opal.LocalJumpError.$new('no block given'); };

  Opal.breaker  = new Error('unexpected break');
  Opal.returner = new Error('unexpected return');

  bridge_class('Array', Array);
  bridge_class('Boolean', Boolean);
  bridge_class('Numeric', Number);
  bridge_class('String', String);
  bridge_class('Proc', Function);
  bridge_class('Exception', Error);
  bridge_class('Regexp', RegExp);
  bridge_class('Time', Date);

  TypeError._super = Error;
}).call(this);
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$new', '$class', '$===', '$respond_to?', '$raise', '$type_error', '$__send__', '$coerce_to', '$nil?', '$<=>', '$name', '$inspect']);
  return (function($base) {
    var self = $module($base, 'Opal');

    var def = self._proto, $scope = self._scope;

    $opal.defs(self, '$type_error', function(object, type, method, coerced) {
      var $a, $b, self = this;

      if (method == null) {
        method = nil
      }
      if (coerced == null) {
        coerced = nil
      }
      if ((($a = (($b = method !== false && method !== nil) ? coerced : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return (($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a).$new("can't convert " + (object.$class()) + " into " + (type) + " (" + (object.$class()) + "#" + (method) + " gives " + (coerced.$class()))
        } else {
        return (($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a).$new("no implicit conversion of " + (object.$class()) + " into " + (type))
      };
    });

    $opal.defs(self, '$coerce_to', function(object, type, method) {
      var $a, self = this;

      if ((($a = type['$==='](object)) !== nil && (!$a._isBoolean || $a == true))) {
        return object};
      if ((($a = object['$respond_to?'](method)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type))
      };
      return object.$__send__(method);
    });

    $opal.defs(self, '$coerce_to!', function(object, type, method) {
      var $a, self = this, coerced = nil;

      coerced = self.$coerce_to(object, type, method);
      if ((($a = type['$==='](coerced)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type, method, coerced))
      };
      return coerced;
    });

    $opal.defs(self, '$coerce_to?', function(object, type, method) {
      var $a, self = this, coerced = nil;

      if ((($a = object['$respond_to?'](method)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return nil
      };
      coerced = self.$coerce_to(object, type, method);
      if ((($a = coerced['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
        return nil};
      if ((($a = type['$==='](coerced)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type, method, coerced))
      };
      return coerced;
    });

    $opal.defs(self, '$try_convert', function(object, type, method) {
      var $a, self = this;

      if ((($a = type['$==='](object)) !== nil && (!$a._isBoolean || $a == true))) {
        return object};
      if ((($a = object['$respond_to?'](method)) !== nil && (!$a._isBoolean || $a == true))) {
        return object.$__send__(method)
        } else {
        return nil
      };
    });

    $opal.defs(self, '$compare', function(a, b) {
      var $a, self = this, compare = nil;

      compare = a['$<=>'](b);
      if ((($a = compare === nil) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + (a.$class().$name()) + " with " + (b.$class().$name()) + " failed")};
      return compare;
    });

    $opal.defs(self, '$destructure', function(args) {
      var self = this;

      
      if (args.length == 1) {
        return args[0];
      }
      else if (args._isArray) {
        return args;
      }
      else {
        return $slice.call(args);
      }
    
    });

    $opal.defs(self, '$respond_to?', function(obj, method) {
      var self = this;

      
      if (obj == null || !obj._klass) {
        return false;
      }
    
      return obj['$respond_to?'](method);
    });

    $opal.defs(self, '$inspect', function(obj) {
      var self = this;

      
      if (obj === undefined) {
        return "undefined";
      }
      else if (obj === null) {
        return "null";
      }
      else if (!obj._klass) {
        return obj.toString();
      }
      else {
        return obj.$inspect();
      }
    
    });
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/helpers.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$attr_reader', '$attr_writer', '$=~', '$raise', '$const_missing', '$to_str', '$to_proc', '$append_features', '$included', '$name', '$new', '$to_s']);
  return (function($base, $super) {
    function $Module(){};
    var self = $Module = $klass($base, $super, 'Module', $Module);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4;

    $opal.defs(self, '$new', TMP_1 = function() {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      
      function AnonModule(){}
      var klass     = Opal.boot(Opal.Module, AnonModule);
      klass._name   = nil;
      klass._klass  = Opal.Module;
      klass.__dep__ = []
      klass.__mod__ = true;
      klass._proto  = {};

      // inherit scope from parent
      $opal.create_scope(Opal.Module._scope, klass);

      if (block !== nil) {
        var block_self = block._s;
        block._s = null;
        block.call(klass);
        block._s = block_self;
      }

      return klass;
    
    });

    def['$==='] = function(object) {
      var $a, self = this;

      if ((($a = object == null) !== nil && (!$a._isBoolean || $a == true))) {
        return false};
      return $opal.is_a(object, self);
    };

    def['$<'] = function(other) {
      var self = this;

      
      var working = self;

      while (working) {
        if (working === other) {
          return true;
        }

        working = working.__parent;
      }

      return false;
    
    };

    def.$alias_method = function(newname, oldname) {
      var self = this;

      
      self._proto['$' + newname] = self._proto['$' + oldname];

      if (self._methods) {
        $opal.donate(self, ['$' + newname ])
      }
    
      return self;
    };

    def.$alias_native = function(mid, jsid) {
      var self = this;

      if (jsid == null) {
        jsid = mid
      }
      return self._proto['$' + mid] = self._proto[jsid];
    };

    def.$ancestors = function() {
      var self = this;

      
      var parent = self,
          result = [];

      while (parent) {
        result.push(parent);
        result = result.concat(parent.__inc__);

        parent = parent._super;
      }

      return result;
    
    };

    def.$append_features = function(klass) {
      var self = this;

      
      var module   = self,
          included = klass.__inc__;

      // check if this module is already included in the klass
      for (var i = 0, length = included.length; i < length; i++) {
        if (included[i] === module) {
          return;
        }
      }

      included.push(module);
      module.__dep__.push(klass);

      // iclass
      var iclass = {
        name: module._name,

        _proto:   module._proto,
        __parent: klass.__parent,
        __iclass: true
      };

      klass.__parent = iclass;

      var donator   = module._proto,
          prototype = klass._proto,
          methods   = module._methods;

      for (var i = 0, length = methods.length; i < length; i++) {
        var method = methods[i];

        if (prototype.hasOwnProperty(method) && !prototype[method]._donated) {
          // if the target class already has a method of the same name defined
          // and that method was NOT donated, then it must be a method defined
          // by the class so we do not want to override it
        }
        else {
          prototype[method] = donator[method];
          prototype[method]._donated = true;
        }
      }

      if (klass.__dep__) {
        $opal.donate(klass, methods.slice(), true);
      }

      $opal.donate_constants(module, klass);
    
      return self;
    };

    def.$attr_accessor = function(names) {
      var $a, $b, self = this;

      names = $slice.call(arguments, 0);
      ($a = self).$attr_reader.apply($a, [].concat(names));
      return ($b = self).$attr_writer.apply($b, [].concat(names));
    };

    def.$attr_reader = function(names) {
      var self = this;

      names = $slice.call(arguments, 0);
      
      var proto = self._proto, cls = self;
      for (var i = 0, length = names.length; i < length; i++) {
        (function(name) {
          proto[name] = nil;
          var func = function() { return this[name] };

          if (cls._isSingleton) {
            proto.constructor.prototype['$' + name] = func;
          }
          else {
            proto['$' + name] = func;
            $opal.donate(self, ['$' + name ]);
          }
        })(names[i]);
      }
    
      return nil;
    };

    def.$attr_writer = function(names) {
      var self = this;

      names = $slice.call(arguments, 0);
      
      var proto = self._proto, cls = self;
      for (var i = 0, length = names.length; i < length; i++) {
        (function(name) {
          proto[name] = nil;
          var func = function(value) { return this[name] = value; };

          if (cls._isSingleton) {
            proto.constructor.prototype['$' + name + '='] = func;
          }
          else {
            proto['$' + name + '='] = func;
            $opal.donate(self, ['$' + name + '=']);
          }
        })(names[i]);
      }
    
      return nil;
    };

    $opal.defn(self, '$attr', def.$attr_accessor);

    def.$constants = function() {
      var self = this;

      return self._scope.constants;
    };

    def['$const_defined?'] = function(name, inherit) {
      var $a, self = this;

      if (inherit == null) {
        inherit = true
      }
      if ((($a = name['$=~'](/^[A-Z]\w*$/)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "wrong constant name " + (name))
      };
      
      scopes = [self._scope];
      if (inherit || self === Opal.Object) {
        var parent = self._super;
        while (parent !== Opal.BasicObject) {
          scopes.push(parent._scope);
          parent = parent._super;
        }
      }

      for (var i = 0, len = scopes.length; i < len; i++) {
        if (scopes[i].hasOwnProperty(name)) {
          return true;
        }
      }

      return false;
    
    };

    def.$const_get = function(name, inherit) {
      var $a, self = this;

      if (inherit == null) {
        inherit = true
      }
      if ((($a = name['$=~'](/^[A-Z]\w*$/)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "wrong constant name " + (name))
      };
      
      var scopes = [self._scope];
      if (inherit || self == Opal.Object) {
        var parent = self._super;
        while (parent !== Opal.BasicObject) {
          scopes.push(parent._scope);
          parent = parent._super;
        }
      }

      for (var i = 0, len = scopes.length; i < len; i++) {
        if (scopes[i].hasOwnProperty(name)) {
          return scopes[i][name];
        }
      }

      return self.$const_missing(name);
    
    };

    def.$const_missing = function(const$) {
      var $a, self = this, name = nil;

      name = self._name;
      return self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "uninitialized constant " + (name) + "::" + (const$));
    };

    def.$const_set = function(name, value) {
      var $a, self = this;

      if ((($a = name['$=~'](/^[A-Z]\w*$/)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "wrong constant name " + (name))
      };
      try {
      name = name.$to_str()
      } catch ($err) {if (true) {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "conversion with #to_str failed")
        }else { throw $err; }
      };
      
      $opal.casgn(self, name, value);
      return value
    ;
    };

    def.$define_method = TMP_2 = function(name, method) {
      var self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      
      if (method) {
        block = method.$to_proc();
      }

      if (block === nil) {
        throw new Error("no block given");
      }

      var jsid    = '$' + name;
      block._jsid = name;
      block._s    = null;
      block._def  = block;

      self._proto[jsid] = block;
      $opal.donate(self, [jsid]);

      return name;
    ;
    };

    def.$remove_method = function(name) {
      var self = this;

      
      var jsid    = '$' + name;
      var current = self._proto[jsid];
      delete self._proto[jsid];

      // Check if we need to reverse $opal.donate
      // $opal.retire(self, [jsid]);
      return self;
    
    };

    def.$include = function(mods) {
      var self = this;

      mods = $slice.call(arguments, 0);
      
      for (var i = mods.length - 1; i >= 0; i--) {
        var mod = mods[i];

        if (mod === self) {
          continue;
        }

        (mod).$append_features(self);
        (mod).$included(self);
      }
    
      return self;
    };

    def['$include?'] = function(mod) {
      var self = this;

      
      for (var cls = self; cls; cls = cls.parent) {
        for (var i = 0; i != cls.__inc__.length; i++) {
          var mod2 = cls.__inc__[i];
          if (mod === mod2) {
            return true;
          }
        }
      }
      return false;
    
    };

    def.$instance_method = function(name) {
      var $a, self = this;

      
      var meth = self._proto['$' + name];

      if (!meth || meth.rb_stub) {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "undefined method `" + (name) + "' for class `" + (self.$name()) + "'");
      }

      return (($a = $scope.UnboundMethod) == null ? $opal.cm('UnboundMethod') : $a).$new(self, meth, name);
    
    };

    def.$instance_methods = function(include_super) {
      var self = this;

      if (include_super == null) {
        include_super = false
      }
      
      var methods = [], proto = self._proto;

      for (var prop in self._proto) {
        if (!include_super && !proto.hasOwnProperty(prop)) {
          continue;
        }

        if (!include_super && proto[prop]._donated) {
          continue;
        }

        if (prop.charAt(0) === '$') {
          methods.push(prop.substr(1));
        }
      }

      return methods;
    
    };

    def.$included = function(mod) {
      var self = this;

      return nil;
    };

    def.$extended = function(mod) {
      var self = this;

      return nil;
    };

    def.$module_eval = TMP_3 = function() {
      var $a, self = this, $iter = TMP_3._p, block = $iter || nil;

      TMP_3._p = null;
      if (block !== false && block !== nil) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no block given")
      };
      
      var old = block._s,
          result;

      block._s = null;
      result = block.call(self);
      block._s = old;

      return result;
    
    };

    $opal.defn(self, '$class_eval', def.$module_eval);

    def.$module_exec = TMP_4 = function() {
      var self = this, $iter = TMP_4._p, block = $iter || nil;

      TMP_4._p = null;
      
      if (block === nil) {
        throw new Error("no block given");
      }

      var block_self = block._s, result;

      block._s = null;
      result = block.apply(self, $slice.call(arguments));
      block._s = block_self;

      return result;
    
    };

    $opal.defn(self, '$class_exec', def.$module_exec);

    def['$method_defined?'] = function(method) {
      var self = this;

      
      var body = self._proto['$' + method];
      return (!!body) && !body.rb_stub;
    
    };

    def.$module_function = function(methods) {
      var self = this;

      methods = $slice.call(arguments, 0);
      
      for (var i = 0, length = methods.length; i < length; i++) {
        var meth = methods[i], func = self._proto['$' + meth];

        self.constructor.prototype['$' + meth] = func;
      }

      return self;
    
    };

    def.$name = function() {
      var self = this;

      
      if (self._full_name) {
        return self._full_name;
      }

      var result = [], base = self;

      while (base) {
        if (base._name === nil) {
          return result.length === 0 ? nil : result.join('::');
        }

        result.unshift(base._name);

        base = base._base_module;

        if (base === $opal.Object) {
          break;
        }
      }

      if (result.length === 0) {
        return nil;
      }

      return self._full_name = result.join('::');
    
    };

    def.$public = function() {
      var self = this;

      return nil;
    };

    def.$private_class_method = function(name) {
      var self = this;

      return self['$' + name] || nil;
    };

    $opal.defn(self, '$private', def.$public);

    $opal.defn(self, '$protected', def.$public);

    def['$private_method_defined?'] = function(obj) {
      var self = this;

      return false;
    };

    def.$private_constant = function() {
      var self = this;

      return nil;
    };

    $opal.defn(self, '$protected_method_defined?', def['$private_method_defined?']);

    $opal.defn(self, '$public_instance_methods', def.$instance_methods);

    $opal.defn(self, '$public_method_defined?', def['$method_defined?']);

    def.$remove_class_variable = function() {
      var self = this;

      return nil;
    };

    def.$remove_const = function(name) {
      var self = this;

      
      var old = self._scope[name];
      delete self._scope[name];
      return old;
    
    };

    def.$to_s = function() {
      var self = this;

      return self.$name().$to_s();
    };

    return (def.$undef_method = function(symbol) {
      var self = this;

      $opal.add_stub_for(self._proto, "$" + symbol);
      return self;
    }, nil) && 'undef_method';
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/module.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$raise', '$allocate']);
  ;
  return (function($base, $super) {
    function $Class(){};
    var self = $Class = $klass($base, $super, 'Class', $Class);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2;

    $opal.defs(self, '$new', TMP_1 = function(sup) {
      var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

      if (sup == null) {
        sup = (($a = $scope.Object) == null ? $opal.cm('Object') : $a)
      }
      TMP_1._p = null;
      
      if (!sup._isClass || sup.__mod__) {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "superclass must be a Class");
      }

      function AnonClass(){};
      var klass       = Opal.boot(sup, AnonClass)
      klass._name     = nil;
      klass.__parent  = sup;

      // inherit scope from parent
      $opal.create_scope(sup._scope, klass);

      sup.$inherited(klass);

      if (block !== nil) {
        var block_self = block._s;
        block._s = null;
        block.call(klass);
        block._s = block_self;
      }

      return klass;
    ;
    });

    def.$allocate = function() {
      var self = this;

      
      var obj = new self._alloc;
      obj._id = Opal.uid();
      return obj;
    
    };

    def.$inherited = function(cls) {
      var self = this;

      return nil;
    };

    def.$new = TMP_2 = function(args) {
      var self = this, $iter = TMP_2._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_2._p = null;
      
      var obj = self.$allocate();

      obj.$initialize._p = block;
      obj.$initialize.apply(obj, args);
      return obj;
    ;
    };

    return (def.$superclass = function() {
      var self = this;

      return self._super || nil;
    }, nil) && 'superclass';
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/class.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$raise']);
  return (function($base, $super) {
    function $BasicObject(){};
    var self = $BasicObject = $klass($base, $super, 'BasicObject', $BasicObject);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4;

    $opal.defn(self, '$initialize', function() {
      var self = this;

      return nil;
    });

    $opal.defn(self, '$==', function(other) {
      var self = this;

      return self === other;
    });

    $opal.defn(self, '$__id__', function() {
      var self = this;

      return self._id || (self._id = Opal.uid());
    });

    $opal.defn(self, '$__send__', TMP_1 = function(symbol, args) {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_1._p = null;
      
      var func = self['$' + symbol]

      if (func) {
        if (block !== nil) {
          func._p = block;
        }

        return func.apply(self, args);
      }

      if (block !== nil) {
        self.$method_missing._p = block;
      }

      return self.$method_missing.apply(self, [symbol].concat(args));
    
    });

    $opal.defn(self, '$!', function() {
      var self = this;

      return false;
    });

    $opal.defn(self, '$eql?', def['$==']);

    $opal.defn(self, '$equal?', def['$==']);

    $opal.defn(self, '$instance_eval', TMP_2 = function() {
      var $a, self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      if (block !== false && block !== nil) {
        } else {
        (($a = $scope.Kernel) == null ? $opal.cm('Kernel') : $a).$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no block given")
      };
      
      var old = block._s,
          result;

      block._s = null;
      result = block.call(self, self);
      block._s = old;

      return result;
    
    });

    $opal.defn(self, '$instance_exec', TMP_3 = function(args) {
      var $a, self = this, $iter = TMP_3._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_3._p = null;
      if (block !== false && block !== nil) {
        } else {
        (($a = $scope.Kernel) == null ? $opal.cm('Kernel') : $a).$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no block given")
      };
      
      var block_self = block._s,
          result;

      block._s = null;
      result = block.apply(self, args);
      block._s = block_self;

      return result;
    
    });

    return ($opal.defn(self, '$method_missing', TMP_4 = function(symbol, args) {
      var $a, self = this, $iter = TMP_4._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_4._p = null;
      return (($a = $scope.Kernel) == null ? $opal.cm('Kernel') : $a).$raise((($a = $scope.NoMethodError) == null ? $opal.cm('NoMethodError') : $a), "undefined method `" + (symbol) + "' for BasicObject instance");
    }), nil) && 'method_missing';
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/basic_object.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $gvars = $opal.gvars;

  $opal.add_stubs(['$raise', '$inspect', '$==', '$name', '$class', '$new', '$respond_to?', '$to_ary', '$to_a', '$allocate', '$copy_instance_variables', '$initialize_clone', '$initialize_copy', '$singleton_class', '$initialize_dup', '$for', '$to_proc', '$append_features', '$extended', '$to_i', '$to_s', '$to_f', '$*', '$===', '$empty?', '$ArgumentError', '$nan?', '$infinite?', '$to_int', '$>', '$length', '$print', '$format', '$puts', '$each', '$<=', '$[]', '$nil?', '$is_a?', '$rand', '$coerce_to', '$respond_to_missing?']);
  return (function($base) {
    var self = $module($base, 'Kernel');

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_9;

    def.$method_missing = TMP_1 = function(symbol, args) {
      var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_1._p = null;
      return self.$raise((($a = $scope.NoMethodError) == null ? $opal.cm('NoMethodError') : $a), "undefined method `" + (symbol) + "' for " + (self.$inspect()));
    };

    def['$=~'] = function(obj) {
      var self = this;

      return false;
    };

    def['$==='] = function(other) {
      var self = this;

      return self['$=='](other);
    };

    def['$<=>'] = function(other) {
      var self = this;

      
      if (self['$=='](other)) {
        return 0;
      }

      return nil;
    ;
    };

    def.$method = function(name) {
      var $a, self = this;

      
      var meth = self['$' + name];

      if (!meth || meth.rb_stub) {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "undefined method `" + (name) + "' for class `" + (self.$class().$name()) + "'");
      }

      return (($a = $scope.Method) == null ? $opal.cm('Method') : $a).$new(self, meth, name);
    
    };

    def.$methods = function(all) {
      var self = this;

      if (all == null) {
        all = true
      }
      
      var methods = [];

      for (var key in self) {
        if (key[0] == "$" && typeof(self[key]) === "function") {
          if (all == false || all === nil) {
            if (!$opal.hasOwnProperty.call(self, key)) {
              continue;
            }
          }
          if (self[key].rb_stub === undefined) {
            methods.push(key.substr(1));
          }
        }
      }

      return methods;
    
    };

    def.$Array = TMP_2 = function(object, args) {
      var self = this, $iter = TMP_2._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_2._p = null;
      
      if (object == null || object === nil) {
        return [];
      }
      else if (object['$respond_to?']("to_ary")) {
        return object.$to_ary();
      }
      else if (object['$respond_to?']("to_a")) {
        return object.$to_a();
      }
      else {
        return [object];
      }
    ;
    };

    def.$caller = function() {
      var self = this;

      return [];
    };

    def.$class = function() {
      var self = this;

      return self._klass;
    };

    def.$copy_instance_variables = function(other) {
      var self = this;

      
      for (var name in other) {
        if (name.charAt(0) !== '$') {
          if (name !== '_id' && name !== '_klass') {
            self[name] = other[name];
          }
        }
      }
    
    };

    def.$clone = function() {
      var self = this, copy = nil;

      copy = self.$class().$allocate();
      copy.$copy_instance_variables(self);
      copy.$initialize_clone(self);
      return copy;
    };

    def.$initialize_clone = function(other) {
      var self = this;

      return self.$initialize_copy(other);
    };

    def.$define_singleton_method = TMP_3 = function(name) {
      var $a, self = this, $iter = TMP_3._p, body = $iter || nil;

      TMP_3._p = null;
      if (body !== false && body !== nil) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to create Proc object without a block")
      };
      
      var jsid   = '$' + name;
      body._jsid = name;
      body._s    = null;
      body._def  = body;

      self.$singleton_class()._proto[jsid] = body;

      return self;
    
    };

    def.$dup = function() {
      var self = this, copy = nil;

      copy = self.$class().$allocate();
      copy.$copy_instance_variables(self);
      copy.$initialize_dup(self);
      return copy;
    };

    def.$initialize_dup = function(other) {
      var self = this;

      return self.$initialize_copy(other);
    };

    def.$enum_for = TMP_4 = function(method, args) {
      var $a, $b, $c, self = this, $iter = TMP_4._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      if (method == null) {
        method = "each"
      }
      TMP_4._p = null;
      return ($a = ($b = (($c = $scope.Enumerator) == null ? $opal.cm('Enumerator') : $c)).$for, $a._p = block.$to_proc(), $a).apply($b, [self, method].concat(args));
    };

    $opal.defn(self, '$to_enum', def.$enum_for);

    def['$equal?'] = function(other) {
      var self = this;

      return self === other;
    };

    def.$extend = function(mods) {
      var self = this;

      mods = $slice.call(arguments, 0);
      
      var singleton = self.$singleton_class();

      for (var i = mods.length - 1; i >= 0; i--) {
        var mod = mods[i];

        (mod).$append_features(singleton);
        (mod).$extended(self);
      }
    ;
      return self;
    };

    def.$format = function(format, args) {
      var self = this;

      args = $slice.call(arguments, 1);
      
      var idx = 0;
      return format.replace(/%(\d+\$)?([-+ 0]*)(\d*|\*(\d+\$)?)(?:\.(\d*|\*(\d+\$)?))?([cspdiubBoxXfgeEG])|(%%)/g, function(str, idx_str, flags, width_str, w_idx_str, prec_str, p_idx_str, spec, escaped) {
        if (escaped) {
          return '%';
        }

        var width,
        prec,
        is_integer_spec = ("diubBoxX".indexOf(spec) != -1),
        is_float_spec = ("eEfgG".indexOf(spec) != -1),
        prefix = '',
        obj;

        if (width_str === undefined) {
          width = undefined;
        } else if (width_str.charAt(0) == '*') {
          var w_idx = idx++;
          if (w_idx_str) {
            w_idx = parseInt(w_idx_str, 10) - 1;
          }
          width = (args[w_idx]).$to_i();
        } else {
          width = parseInt(width_str, 10);
        }
        if (!prec_str) {
          prec = is_float_spec ? 6 : undefined;
        } else if (prec_str.charAt(0) == '*') {
          var p_idx = idx++;
          if (p_idx_str) {
            p_idx = parseInt(p_idx_str, 10) - 1;
          }
          prec = (args[p_idx]).$to_i();
        } else {
          prec = parseInt(prec_str, 10);
        }
        if (idx_str) {
          idx = parseInt(idx_str, 10) - 1;
        }
        switch (spec) {
        case 'c':
          obj = args[idx];
          if (obj._isString) {
            str = obj.charAt(0);
          } else {
            str = String.fromCharCode((obj).$to_i());
          }
          break;
        case 's':
          str = (args[idx]).$to_s();
          if (prec !== undefined) {
            str = str.substr(0, prec);
          }
          break;
        case 'p':
          str = (args[idx]).$inspect();
          if (prec !== undefined) {
            str = str.substr(0, prec);
          }
          break;
        case 'd':
        case 'i':
        case 'u':
          str = (args[idx]).$to_i().toString();
          break;
        case 'b':
        case 'B':
          str = (args[idx]).$to_i().toString(2);
          break;
        case 'o':
          str = (args[idx]).$to_i().toString(8);
          break;
        case 'x':
        case 'X':
          str = (args[idx]).$to_i().toString(16);
          break;
        case 'e':
        case 'E':
          str = (args[idx]).$to_f().toExponential(prec);
          break;
        case 'f':
          str = (args[idx]).$to_f().toFixed(prec);
          break;
        case 'g':
        case 'G':
          str = (args[idx]).$to_f().toPrecision(prec);
          break;
        }
        idx++;
        if (is_integer_spec || is_float_spec) {
          if (str.charAt(0) == '-') {
            prefix = '-';
            str = str.substr(1);
          } else {
            if (flags.indexOf('+') != -1) {
              prefix = '+';
            } else if (flags.indexOf(' ') != -1) {
              prefix = ' ';
            }
          }
        }
        if (is_integer_spec && prec !== undefined) {
          if (str.length < prec) {
            str = "0"['$*'](prec - str.length) + str;
          }
        }
        var total_len = prefix.length + str.length;
        if (width !== undefined && total_len < width) {
          if (flags.indexOf('-') != -1) {
            str = str + " "['$*'](width - total_len);
          } else {
            var pad_char = ' ';
            if (flags.indexOf('0') != -1) {
              str = "0"['$*'](width - total_len) + str;
            } else {
              prefix = " "['$*'](width - total_len) + prefix;
            }
          }
        }
        var result = prefix + str;
        if ('XEG'.indexOf(spec) != -1) {
          result = result.toUpperCase();
        }
        return result;
      });
    
    };

    def.$hash = function() {
      var self = this;

      return self._id;
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return nil;
    };

    def.$inspect = function() {
      var self = this;

      return self.$to_s();
    };

    def['$instance_of?'] = function(klass) {
      var self = this;

      return self._klass === klass;
    };

    def['$instance_variable_defined?'] = function(name) {
      var self = this;

      return $opal.hasOwnProperty.call(self, name.substr(1));
    };

    def.$instance_variable_get = function(name) {
      var self = this;

      
      var ivar = self[name.substr(1)];

      return ivar == null ? nil : ivar;
    
    };

    def.$instance_variable_set = function(name, value) {
      var self = this;

      return self[name.substr(1)] = value;
    };

    def.$instance_variables = function() {
      var self = this;

      
      var result = [];

      for (var name in self) {
        if (name.charAt(0) !== '$') {
          if (name !== '_klass' && name !== '_id') {
            result.push('@' + name);
          }
        }
      }

      return result;
    
    };

    def.$Integer = function(value, base) {
      var $a, $b, self = this, $case = nil;

      if (base == null) {
        base = nil
      }
      if ((($a = (($b = $scope.String) == null ? $opal.cm('String') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = value['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "invalid value for Integer: (empty string)")};
        return parseInt(value, ((($a = base) !== false && $a !== nil) ? $a : undefined));};
      if (base !== false && base !== nil) {
        self.$raise(self.$ArgumentError("base is only valid for String values"))};
      return (function() {$case = value;if ((($a = $scope.Integer) == null ? $opal.cm('Integer') : $a)['$===']($case)) {return value}else if ((($a = $scope.Float) == null ? $opal.cm('Float') : $a)['$===']($case)) {if ((($a = ((($b = value['$nan?']()) !== false && $b !== nil) ? $b : value['$infinite?']())) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.FloatDomainError) == null ? $opal.cm('FloatDomainError') : $a), "unable to coerce " + (value) + " to Integer")};
      return value.$to_int();}else if ((($a = $scope.NilClass) == null ? $opal.cm('NilClass') : $a)['$===']($case)) {return self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "can't convert nil into Integer")}else {if ((($a = value['$respond_to?']("to_int")) !== nil && (!$a._isBoolean || $a == true))) {
        return value.$to_int()
      } else if ((($a = value['$respond_to?']("to_i")) !== nil && (!$a._isBoolean || $a == true))) {
        return value.$to_i()
        } else {
        return self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "can't convert " + (value.$class()) + " into Integer")
      }}})();
    };

    def.$Float = function(value) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.String) == null ? $opal.cm('String') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
        return parseFloat(value);
      } else if ((($a = value['$respond_to?']("to_f")) !== nil && (!$a._isBoolean || $a == true))) {
        return value.$to_f()
        } else {
        return self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "can't convert " + (value.$class()) + " into Float")
      };
    };

    def['$is_a?'] = function(klass) {
      var self = this;

      return $opal.is_a(self, klass);
    };

    $opal.defn(self, '$kind_of?', def['$is_a?']);

    def.$lambda = TMP_5 = function() {
      var self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      block.is_lambda = true;
      return block;
    };

    def.$loop = TMP_6 = function() {
      var self = this, $iter = TMP_6._p, block = $iter || nil;

      TMP_6._p = null;
      
      while (true) {
        if (block() === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def['$nil?'] = function() {
      var self = this;

      return false;
    };

    $opal.defn(self, '$object_id', def.$__id__);

    def.$printf = function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      if (args.$length()['$>'](0)) {
        self.$print(($a = self).$format.apply($a, [].concat(args)))};
      return nil;
    };

    def.$private_methods = function() {
      var self = this;

      return [];
    };

    def.$proc = TMP_7 = function() {
      var $a, self = this, $iter = TMP_7._p, block = $iter || nil;

      TMP_7._p = null;
      if (block !== false && block !== nil) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to create Proc object without a block")
      };
      block.is_lambda = false;
      return block;
    };

    def.$puts = function(strs) {
      var $a, self = this;
      if ($gvars.stdout == null) $gvars.stdout = nil;

      strs = $slice.call(arguments, 0);
      return ($a = $gvars.stdout).$puts.apply($a, [].concat(strs));
    };

    def.$p = function(args) {
      var $a, $b, TMP_8, self = this;

      args = $slice.call(arguments, 0);
      ($a = ($b = args).$each, $a._p = (TMP_8 = function(obj){var self = TMP_8._s || this;
        if ($gvars.stdout == null) $gvars.stdout = nil;
if (obj == null) obj = nil;
      return $gvars.stdout.$puts(obj.$inspect())}, TMP_8._s = self, TMP_8), $a).call($b);
      if (args.$length()['$<='](1)) {
        return args['$[]'](0)
        } else {
        return args
      };
    };

    def.$print = function(strs) {
      var $a, self = this;
      if ($gvars.stdout == null) $gvars.stdout = nil;

      strs = $slice.call(arguments, 0);
      return ($a = $gvars.stdout).$print.apply($a, [].concat(strs));
    };

    def.$warn = function(strs) {
      var $a, $b, self = this;
      if ($gvars.VERBOSE == null) $gvars.VERBOSE = nil;
      if ($gvars.stderr == null) $gvars.stderr = nil;

      strs = $slice.call(arguments, 0);
      if ((($a = ((($b = $gvars.VERBOSE['$nil?']()) !== false && $b !== nil) ? $b : strs['$empty?']())) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        ($a = $gvars.stderr).$puts.apply($a, [].concat(strs))
      };
      return nil;
    };

    def.$raise = function(exception, string) {
      var $a, self = this;
      if ($gvars["!"] == null) $gvars["!"] = nil;

      
      if (exception == null && $gvars["!"]) {
        exception = $gvars["!"];
      }
      else if (exception._isString) {
        exception = (($a = $scope.RuntimeError) == null ? $opal.cm('RuntimeError') : $a).$new(exception);
      }
      else if (!exception['$is_a?']((($a = $scope.Exception) == null ? $opal.cm('Exception') : $a))) {
        exception = exception.$new(string);
      }

      $gvars["!"] = exception;
      throw exception;
    ;
    };

    $opal.defn(self, '$fail', def.$raise);

    def.$rand = function(max) {
      var $a, self = this;

      
      if (max === undefined) {
        return Math.random();
      }
      else if (max._isRange) {
        var arr = max.$to_a();

        return arr[self.$rand(arr.length)];
      }
      else {
        return Math.floor(Math.random() *
          Math.abs((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(max, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")));
      }
    
    };

    $opal.defn(self, '$srand', def.$rand);

    def['$respond_to?'] = function(name, include_all) {
      var $a, self = this;

      if (include_all == null) {
        include_all = false
      }
      if ((($a = self['$respond_to_missing?'](name)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      
      var body = self['$' + name];

      if (typeof(body) === "function" && !body.rb_stub) {
        return true;
      }
    
      return false;
    };

    $opal.defn(self, '$send', def.$__send__);

    $opal.defn(self, '$public_send', def.$__send__);

    def.$singleton_class = function() {
      var self = this;

      
      if (self._isClass) {
        if (self.__meta__) {
          return self.__meta__;
        }

        var meta = new $opal.Class._alloc;
        meta._klass = $opal.Class;
        self.__meta__ = meta;
        // FIXME - is this right? (probably - methods defined on
        // class' singleton should also go to subclasses?)
        meta._proto = self.constructor.prototype;
        meta._isSingleton = true;
        meta.__inc__ = [];
        meta._methods = [];

        meta._scope = self._scope;

        return meta;
      }

      if (self._isClass) {
        return self._klass;
      }

      if (self.__meta__) {
        return self.__meta__;
      }

      else {
        var orig_class = self._klass,
            class_id   = "#<Class:#<" + orig_class._name + ":" + orig_class._id + ">>";

        var Singleton = function () {};
        var meta = Opal.boot(orig_class, Singleton);
        meta._name = class_id;

        meta._proto = self;
        self.__meta__ = meta;
        meta._klass = orig_class._klass;
        meta._scope = orig_class._scope;
        meta.__parent = orig_class;

        return meta;
      }
    
    };

    $opal.defn(self, '$sprintf', def.$format);

    def.$String = function(str) {
      var self = this;

      return String(str);
    };

    def.$tap = TMP_9 = function() {
      var self = this, $iter = TMP_9._p, block = $iter || nil;

      TMP_9._p = null;
      if ($opal.$yield1(block, self) === $breaker) return $breaker.$v;
      return self;
    };

    def.$to_proc = function() {
      var self = this;

      return self;
    };

    def.$to_s = function() {
      var self = this;

      return "#<" + self.$class().$name() + ":" + self._id + ">";
    };

    def.$freeze = function() {
      var self = this;

      self.___frozen___ = true;
      return self;
    };

    def['$frozen?'] = function() {
      var $a, self = this;
      if (self.___frozen___ == null) self.___frozen___ = nil;

      return ((($a = self.___frozen___) !== false && $a !== nil) ? $a : false);
    };

    def['$respond_to_missing?'] = function(method_name) {
      var self = this;

      return false;
    };
        ;$opal.donate(self, ["$method_missing", "$=~", "$===", "$<=>", "$method", "$methods", "$Array", "$caller", "$class", "$copy_instance_variables", "$clone", "$initialize_clone", "$define_singleton_method", "$dup", "$initialize_dup", "$enum_for", "$to_enum", "$equal?", "$extend", "$format", "$hash", "$initialize_copy", "$inspect", "$instance_of?", "$instance_variable_defined?", "$instance_variable_get", "$instance_variable_set", "$instance_variables", "$Integer", "$Float", "$is_a?", "$kind_of?", "$lambda", "$loop", "$nil?", "$object_id", "$printf", "$private_methods", "$proc", "$puts", "$p", "$print", "$warn", "$raise", "$fail", "$rand", "$srand", "$respond_to?", "$send", "$public_send", "$singleton_class", "$sprintf", "$String", "$tap", "$to_proc", "$to_s", "$freeze", "$frozen?", "$respond_to_missing?"]);
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/kernel.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$raise']);
  (function($base, $super) {
    function $NilClass(){};
    var self = $NilClass = $klass($base, $super, 'NilClass', $NilClass);

    var def = self._proto, $scope = self._scope;

    def['$!'] = function() {
      var self = this;

      return true;
    };

    def['$&'] = function(other) {
      var self = this;

      return false;
    };

    def['$|'] = function(other) {
      var self = this;

      return other !== false && other !== nil;
    };

    def['$^'] = function(other) {
      var self = this;

      return other !== false && other !== nil;
    };

    def['$=='] = function(other) {
      var self = this;

      return other === nil;
    };

    def.$dup = function() {
      var $a, self = this;

      return self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a));
    };

    def.$inspect = function() {
      var self = this;

      return "nil";
    };

    def['$nil?'] = function() {
      var self = this;

      return true;
    };

    def.$singleton_class = function() {
      var $a, self = this;

      return (($a = $scope.NilClass) == null ? $opal.cm('NilClass') : $a);
    };

    def.$to_a = function() {
      var self = this;

      return [];
    };

    def.$to_h = function() {
      var self = this;

      return $opal.hash();
    };

    def.$to_i = function() {
      var self = this;

      return 0;
    };

    $opal.defn(self, '$to_f', def.$to_i);

    def.$to_s = function() {
      var self = this;

      return "";
    };

    def.$object_id = function() {
      var $a, self = this;

      return (($a = $scope.NilClass) == null ? $opal.cm('NilClass') : $a)._id || ((($a = $scope.NilClass) == null ? $opal.cm('NilClass') : $a)._id = $opal.uid());
    };

    return $opal.defn(self, '$hash', def.$object_id);
  })(self, null);
  return $opal.cdecl($scope, 'NIL', nil);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/nil_class.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$undef_method']);
  (function($base, $super) {
    function $Boolean(){};
    var self = $Boolean = $klass($base, $super, 'Boolean', $Boolean);

    var def = self._proto, $scope = self._scope;

    def._isBoolean = true;

    (function(self) {
      var $scope = self._scope, def = self._proto;

      return self.$undef_method("new")
    })(self.$singleton_class());

    def['$!'] = function() {
      var self = this;

      return self != true;
    };

    def['$&'] = function(other) {
      var self = this;

      return (self == true) ? (other !== false && other !== nil) : false;
    };

    def['$|'] = function(other) {
      var self = this;

      return (self == true) ? true : (other !== false && other !== nil);
    };

    def['$^'] = function(other) {
      var self = this;

      return (self == true) ? (other === false || other === nil) : (other !== false && other !== nil);
    };

    def['$=='] = function(other) {
      var self = this;

      return (self == true) === other.valueOf();
    };

    $opal.defn(self, '$equal?', def['$==']);

    $opal.defn(self, '$singleton_class', def.$class);

    return (def.$to_s = function() {
      var self = this;

      return (self == true) ? 'true' : 'false';
    }, nil) && 'to_s';
  })(self, null);
  $opal.cdecl($scope, 'TrueClass', (($a = $scope.Boolean) == null ? $opal.cm('Boolean') : $a));
  $opal.cdecl($scope, 'FalseClass', (($a = $scope.Boolean) == null ? $opal.cm('Boolean') : $a));
  $opal.cdecl($scope, 'TRUE', true);
  return $opal.cdecl($scope, 'FALSE', false);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/boolean.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $module = $opal.module;

  $opal.add_stubs(['$attr_reader', '$name', '$class']);
  (function($base, $super) {
    function $Exception(){};
    var self = $Exception = $klass($base, $super, 'Exception', $Exception);

    var def = self._proto, $scope = self._scope;

    def.message = nil;
    self.$attr_reader("message");

    $opal.defs(self, '$new', function(message) {
      var self = this;

      if (message == null) {
        message = ""
      }
      
      var err = new Error(message);
      err._klass = self;
      err.name = self._name;
      return err;
    
    });

    def.$backtrace = function() {
      var self = this;

      
      var backtrace = self.stack;

      if (typeof(backtrace) === 'string') {
        return backtrace.split("\n").slice(0, 15);
      }
      else if (backtrace) {
        return backtrace.slice(0, 15);
      }

      return [];
    
    };

    def.$inspect = function() {
      var self = this;

      return "#<" + (self.$class().$name()) + ": '" + (self.message) + "'>";
    };

    return $opal.defn(self, '$to_s', def.$message);
  })(self, null);
  (function($base, $super) {
    function $ScriptError(){};
    var self = $ScriptError = $klass($base, $super, 'ScriptError', $ScriptError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.Exception) == null ? $opal.cm('Exception') : $a));
  (function($base, $super) {
    function $SyntaxError(){};
    var self = $SyntaxError = $klass($base, $super, 'SyntaxError', $SyntaxError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.ScriptError) == null ? $opal.cm('ScriptError') : $a));
  (function($base, $super) {
    function $LoadError(){};
    var self = $LoadError = $klass($base, $super, 'LoadError', $LoadError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.ScriptError) == null ? $opal.cm('ScriptError') : $a));
  (function($base, $super) {
    function $NotImplementedError(){};
    var self = $NotImplementedError = $klass($base, $super, 'NotImplementedError', $NotImplementedError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.ScriptError) == null ? $opal.cm('ScriptError') : $a));
  (function($base, $super) {
    function $SystemExit(){};
    var self = $SystemExit = $klass($base, $super, 'SystemExit', $SystemExit);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.Exception) == null ? $opal.cm('Exception') : $a));
  (function($base, $super) {
    function $StandardError(){};
    var self = $StandardError = $klass($base, $super, 'StandardError', $StandardError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.Exception) == null ? $opal.cm('Exception') : $a));
  (function($base, $super) {
    function $NameError(){};
    var self = $NameError = $klass($base, $super, 'NameError', $NameError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $NoMethodError(){};
    var self = $NoMethodError = $klass($base, $super, 'NoMethodError', $NoMethodError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.NameError) == null ? $opal.cm('NameError') : $a));
  (function($base, $super) {
    function $RuntimeError(){};
    var self = $RuntimeError = $klass($base, $super, 'RuntimeError', $RuntimeError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $LocalJumpError(){};
    var self = $LocalJumpError = $klass($base, $super, 'LocalJumpError', $LocalJumpError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $TypeError(){};
    var self = $TypeError = $klass($base, $super, 'TypeError', $TypeError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $ArgumentError(){};
    var self = $ArgumentError = $klass($base, $super, 'ArgumentError', $ArgumentError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $IndexError(){};
    var self = $IndexError = $klass($base, $super, 'IndexError', $IndexError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $StopIteration(){};
    var self = $StopIteration = $klass($base, $super, 'StopIteration', $StopIteration);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a));
  (function($base, $super) {
    function $KeyError(){};
    var self = $KeyError = $klass($base, $super, 'KeyError', $KeyError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a));
  (function($base, $super) {
    function $RangeError(){};
    var self = $RangeError = $klass($base, $super, 'RangeError', $RangeError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $FloatDomainError(){};
    var self = $FloatDomainError = $klass($base, $super, 'FloatDomainError', $FloatDomainError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.RangeError) == null ? $opal.cm('RangeError') : $a));
  (function($base, $super) {
    function $IOError(){};
    var self = $IOError = $klass($base, $super, 'IOError', $IOError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $SystemCallError(){};
    var self = $SystemCallError = $klass($base, $super, 'SystemCallError', $SystemCallError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  return (function($base) {
    var self = $module($base, 'Errno');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $EINVAL(){};
      var self = $EINVAL = $klass($base, $super, 'EINVAL', $EINVAL);

      var def = self._proto, $scope = self._scope, TMP_1;

      return ($opal.defs(self, '$new', TMP_1 = function() {
        var self = this, $iter = TMP_1._p, $yield = $iter || nil;

        TMP_1._p = null;
        return $opal.find_super_dispatcher(self, 'new', TMP_1, null, $EINVAL).apply(self, ["Invalid argument"]);
      }), nil) && 'new'
    })(self, (($a = $scope.SystemCallError) == null ? $opal.cm('SystemCallError') : $a))
    
  })(self);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/error.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$respond_to?', '$to_str', '$to_s', '$coerce_to', '$new', '$raise', '$class', '$call']);
  return (function($base, $super) {
    function $Regexp(){};
    var self = $Regexp = $klass($base, $super, 'Regexp', $Regexp);

    var def = self._proto, $scope = self._scope, TMP_1;

    def._isRegexp = true;

    (function(self) {
      var $scope = self._scope, def = self._proto;

      self._proto.$escape = function(string) {
        var self = this;

        
        return string.replace(/([-[\]/{}()*+?.^$\\| ])/g, '\\$1')
                     .replace(/[\n]/g, '\\n')
                     .replace(/[\r]/g, '\\r')
                     .replace(/[\f]/g, '\\f')
                     .replace(/[\t]/g, '\\t');
      
      };
      self._proto.$quote = self._proto.$escape;
      self._proto.$union = function(parts) {
        var self = this;

        parts = $slice.call(arguments, 0);
        return new RegExp(parts.join(''));
      };
      return (self._proto.$new = function(regexp, options) {
        var self = this;

        return new RegExp(regexp, options);
      }, nil) && 'new';
    })(self.$singleton_class());

    def['$=='] = function(other) {
      var self = this;

      return other.constructor == RegExp && self.toString() === other.toString();
    };

    def['$==='] = function(str) {
      var self = this;

      
      if (!str._isString && str['$respond_to?']("to_str")) {
        str = str.$to_str();
      }

      if (!str._isString) {
        return false;
      }

      return self.test(str);
    ;
    };

    def['$=~'] = function(string) {
      var $a, self = this;

      if ((($a = string === nil) !== nil && (!$a._isBoolean || $a == true))) {
        $gvars["~"] = $gvars["`"] = $gvars["'"] = nil;
        return nil;};
      string = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(string, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
      
      var re = self;

      if (re.global) {
        // should we clear it afterwards too?
        re.lastIndex = 0;
      }
      else {
        // rewrite regular expression to add the global flag to capture pre/post match
        re = new RegExp(re.source, 'g' + (re.multiline ? 'm' : '') + (re.ignoreCase ? 'i' : ''));
      }

      var result = re.exec(string);

      if (result) {
        $gvars["~"] = (($a = $scope.MatchData) == null ? $opal.cm('MatchData') : $a).$new(re, result);
      }
      else {
        $gvars["~"] = $gvars["`"] = $gvars["'"] = nil;
      }

      return result ? result.index : nil;
    
    };

    $opal.defn(self, '$eql?', def['$==']);

    def.$inspect = function() {
      var self = this;

      return self.toString();
    };

    def.$match = TMP_1 = function(string, pos) {
      var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      if ((($a = string === nil) !== nil && (!$a._isBoolean || $a == true))) {
        $gvars["~"] = $gvars["`"] = $gvars["'"] = nil;
        return nil;};
      if ((($a = string._isString == null) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = string['$respond_to?']("to_str")) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "no implicit conversion of " + (string.$class()) + " into String")
        };
        string = string.$to_str();};
      
      var re = self;

      if (re.global) {
        // should we clear it afterwards too?
        re.lastIndex = 0;
      }
      else {
        re = new RegExp(re.source, 'g' + (re.multiline ? 'm' : '') + (re.ignoreCase ? 'i' : ''));
      }

      var result = re.exec(string);

      if (result) {
        result = $gvars["~"] = (($a = $scope.MatchData) == null ? $opal.cm('MatchData') : $a).$new(re, result);

        if (block === nil) {
          return result;
        }
        else {
          return block.$call(result);
        }
      }
      else {
        return $gvars["~"] = $gvars["`"] = $gvars["'"] = nil;
      }
    
    };

    def.$source = function() {
      var self = this;

      return self.source;
    };

    return $opal.defn(self, '$to_s', def.$source);
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/regexp.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$===', '$>', '$<', '$equal?', '$<=>', '$==', '$normalize', '$raise', '$class', '$>=', '$<=']);
  return (function($base) {
    var self = $module($base, 'Comparable');

    var def = self._proto, $scope = self._scope;

    $opal.defs(self, '$normalize', function(what) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](what)) !== nil && (!$a._isBoolean || $a == true))) {
        return what};
      if (what['$>'](0)) {
        return 1};
      if (what['$<'](0)) {
        return -1};
      return 0;
    });

    def['$=='] = function(other) {
      var $a, self = this, cmp = nil;

      try {
      if ((($a = self['$equal?'](other)) !== nil && (!$a._isBoolean || $a == true))) {
          return true};
        if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          return false
        };
        return (($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a).$normalize(cmp)['$=='](0);
      } catch ($err) {if ($opal.$rescue($err, [(($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a)])) {
        return false
        }else { throw $err; }
      };
    };

    def['$>'] = function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return (($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a).$normalize(cmp)['$>'](0);
    };

    def['$>='] = function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return (($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a).$normalize(cmp)['$>='](0);
    };

    def['$<'] = function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return (($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a).$normalize(cmp)['$<'](0);
    };

    def['$<='] = function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return (($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a).$normalize(cmp)['$<='](0);
    };

    def['$between?'] = function(min, max) {
      var self = this;

      if (self['$<'](min)) {
        return false};
      if (self['$>'](max)) {
        return false};
      return true;
    };
        ;$opal.donate(self, ["$==", "$>", "$>=", "$<", "$<=", "$between?"]);
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/comparable.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$raise', '$enum_for', '$flatten', '$map', '$==', '$destructure', '$nil?', '$coerce_to!', '$coerce_to', '$===', '$new', '$<<', '$[]', '$[]=', '$inspect', '$__send__', '$yield', '$enumerator_size', '$respond_to?', '$size', '$private', '$compare', '$<=>', '$dup', '$sort', '$call', '$first', '$zip', '$to_a']);
  return (function($base) {
    var self = $module($base, 'Enumerable');

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_22, TMP_23, TMP_24, TMP_25, TMP_26, TMP_27, TMP_28, TMP_29, TMP_30, TMP_31, TMP_32, TMP_33, TMP_35, TMP_36, TMP_40, TMP_41;

    def['$all?'] = TMP_1 = function() {
      var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      
      var result = true;

      if (block !== nil) {
        self.$each._p = function() {
          var value = $opal.$yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) === nil || ($a._isBoolean && $a == false))) {
            result = false;
            return $breaker;
          }
        }
      }
      else {
        self.$each._p = function(obj) {
          if (arguments.length == 1 && (($a = obj) === nil || ($a._isBoolean && $a == false))) {
            result = false;
            return $breaker;
          }
        }
      }

      self.$each();

      return result;
    
    };

    def['$any?'] = TMP_2 = function() {
      var $a, self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      
      var result = false;

      if (block !== nil) {
        self.$each._p = function() {
          var value = $opal.$yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            result = true;
            return $breaker;
          }
        };
      }
      else {
        self.$each._p = function(obj) {
          if (arguments.length != 1 || (($a = obj) !== nil && (!$a._isBoolean || $a == true))) {
            result = true;
            return $breaker;
          }
        }
      }

      self.$each();

      return result;
    
    };

    def.$chunk = TMP_3 = function(state) {
      var $a, self = this, $iter = TMP_3._p, block = $iter || nil;

      TMP_3._p = null;
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def.$collect = TMP_4 = function() {
      var self = this, $iter = TMP_4._p, block = $iter || nil;

      TMP_4._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect")
      };
      
      var result = [];

      self.$each._p = function() {
        var value = $opal.$yieldX(block, arguments);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        result.push(value);
      };

      self.$each();

      return result;
    
    };

    def.$collect_concat = TMP_5 = function() {
      var $a, $b, TMP_6, self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect_concat")
      };
      return ($a = ($b = self).$map, $a._p = (TMP_6 = function(item){var self = TMP_6._s || this, $a;
if (item == null) item = nil;
      return $a = $opal.$yield1(block, item), $a === $breaker ? $a : $a}, TMP_6._s = self, TMP_6), $a).call($b).$flatten(1);
    };

    def.$count = TMP_7 = function(object) {
      var $a, self = this, $iter = TMP_7._p, block = $iter || nil;

      TMP_7._p = null;
      
      var result = 0;

      if (object != null) {
        block = function() {
          return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments)['$=='](object);
        };
      }
      else if (block === nil) {
        block = function() { return true; };
      }

      self.$each._p = function() {
        var value = $opal.$yieldX(block, arguments);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
          result++;
        }
      }

      self.$each();

      return result;
    
    };

    def.$cycle = TMP_8 = function(n) {
      var $a, self = this, $iter = TMP_8._p, block = $iter || nil;

      if (n == null) {
        n = nil
      }
      TMP_8._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("cycle", n)
      };
      if ((($a = n['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        n = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](n, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if ((($a = n <= 0) !== nil && (!$a._isBoolean || $a == true))) {
          return nil};
      };
      
      var result,
          all  = [];

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        all.push(param);
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }

      if (all.length === 0) {
        return nil;
      }
    
      if ((($a = n['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
        
        while (true) {
          for (var i = 0, length = all.length; i < length; i++) {
            var value = $opal.$yield1(block, all[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }
        }
      
        } else {
        
        while (n > 1) {
          for (var i = 0, length = all.length; i < length; i++) {
            var value = $opal.$yield1(block, all[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }

          n--;
        }
      
      };
    };

    def.$detect = TMP_9 = function(ifnone) {
      var $a, self = this, $iter = TMP_9._p, block = $iter || nil;

      TMP_9._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("detect", ifnone)
      };
      
      var result = undefined;

      self.$each._p = function() {
        var params = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value  = $opal.$yield1(block, params);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
          result = params;
          return $breaker;
        }
      };

      self.$each();

      if (result === undefined && ifnone !== undefined) {
        if (typeof(ifnone) === 'function') {
          result = ifnone();
        }
        else {
          result = ifnone;
        }
      }

      return result === undefined ? nil : result;
    
    };

    def.$drop = function(number) {
      var $a, self = this;

      number = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(number, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      if ((($a = number < 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "attempt to drop negative size")};
      
      var result  = [],
          current = 0;

      self.$each._p = function() {
        if (number <= current) {
          result.push((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments));
        }

        current++;
      };

      self.$each()

      return result;
    
    };

    def.$drop_while = TMP_10 = function() {
      var $a, self = this, $iter = TMP_10._p, block = $iter || nil;

      TMP_10._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("drop_while")
      };
      
      var result   = [],
          dropping = true;

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

        if (dropping) {
          var value = $opal.$yield1(block, param);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) === nil || ($a._isBoolean && $a == false))) {
            dropping = false;
            result.push(param);
          }
        }
        else {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    };

    def.$each_cons = TMP_11 = function(n) {
      var $a, self = this, $iter = TMP_11._p, block = $iter || nil;

      TMP_11._p = null;
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def.$each_entry = TMP_12 = function() {
      var $a, self = this, $iter = TMP_12._p, block = $iter || nil;

      TMP_12._p = null;
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def.$each_slice = TMP_13 = function(n) {
      var $a, self = this, $iter = TMP_13._p, block = $iter || nil;

      TMP_13._p = null;
      n = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(n, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      if ((($a = n <= 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "invalid slice size")};
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_slice", n)
      };
      
      var result,
          slice = []

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

        slice.push(param);

        if (slice.length === n) {
          if ($opal.$yield1(block, slice) === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          slice = [];
        }
      };

      self.$each();

      if (result !== undefined) {
        return result;
      }

      // our "last" group, if smaller than n then won't have been yielded
      if (slice.length > 0) {
        if ($opal.$yield1(block, slice) === $breaker) {
          return $breaker.$v;
        }
      }
    ;
      return nil;
    };

    def.$each_with_index = TMP_14 = function(args) {
      var $a, $b, self = this, $iter = TMP_14._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_14._p = null;
      if ((block !== nil)) {
        } else {
        return ($a = self).$enum_for.apply($a, ["each_with_index"].concat(args))
      };
      
      var result,
          index = 0;

      self.$each._p = function() {
        var param = (($b = $scope.Opal) == null ? $opal.cm('Opal') : $b).$destructure(arguments),
            value = block(param, index);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        index++;
      };

      self.$each.apply(self, args);

      if (result !== undefined) {
        return result;
      }
    
      return self;
    };

    def.$each_with_object = TMP_15 = function(object) {
      var $a, self = this, $iter = TMP_15._p, block = $iter || nil;

      TMP_15._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_with_object", object)
      };
      
      var result;

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = block(param, object);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }
      };

      self.$each();

      if (result !== undefined) {
        return result;
      }
    
      return object;
    };

    def.$entries = function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      
      var result = [];

      self.$each._p = function() {
        result.push((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments));
      };

      self.$each.apply(self, args);

      return result;
    
    };

    $opal.defn(self, '$find', def.$detect);

    def.$find_all = TMP_16 = function() {
      var $a, self = this, $iter = TMP_16._p, block = $iter || nil;

      TMP_16._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("find_all")
      };
      
      var result = [];

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    };

    def.$find_index = TMP_17 = function(object) {
      var $a, self = this, $iter = TMP_17._p, block = $iter || nil;

      TMP_17._p = null;
      if ((($a = object === undefined && block === nil) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$enum_for("find_index")};
      
      var result = nil,
          index  = 0;

      if (object != null) {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if ((param)['$=='](object)) {
            result = index;
            return $breaker;
          }

          index += 1;
        };
      }
      else if (block !== nil) {
        self.$each._p = function() {
          var value = $opal.$yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            result = index;
            return $breaker;
          }

          index += 1;
        };
      }

      self.$each();

      return result;
    
    };

    def.$first = function(number) {
      var $a, self = this, result = nil;

      if ((($a = number === undefined) !== nil && (!$a._isBoolean || $a == true))) {
        result = nil;
        
        self.$each._p = function() {
          result = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          return $breaker;
        };

        self.$each();
      ;
        } else {
        result = [];
        number = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(number, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if ((($a = number < 0) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "attempt to take negative size")};
        if ((($a = number == 0) !== nil && (!$a._isBoolean || $a == true))) {
          return []};
        
        var current = 0,
            number  = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(number, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

        self.$each._p = function() {
          result.push((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments));

          if (number <= ++current) {
            return $breaker;
          }
        };

        self.$each();
      ;
      };
      return result;
    };

    $opal.defn(self, '$flat_map', def.$collect_concat);

    def.$grep = TMP_18 = function(pattern) {
      var $a, self = this, $iter = TMP_18._p, block = $iter || nil;

      TMP_18._p = null;
      
      var result = [];

      if (block !== nil) {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
              value = pattern['$==='](param);

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            value = $opal.$yield1(block, param);

            if (value === $breaker) {
              result = $breaker.$v;
              return $breaker;
            }

            result.push(value);
          }
        };
      }
      else {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
              value = pattern['$==='](param);

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            result.push(param);
          }
        };
      }

      self.$each();

      return result;
    ;
    };

    def.$group_by = TMP_19 = function() {
      var $a, $b, $c, self = this, $iter = TMP_19._p, block = $iter || nil, hash = nil;

      TMP_19._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("group_by")
      };
      hash = (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a).$new();
      
      var result;

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        (($a = value, $b = hash, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, []))))['$<<'](param);
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }
    
      return hash;
    };

    def['$include?'] = function(obj) {
      var $a, self = this;

      
      var result = false;

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

        if ((param)['$=='](obj)) {
          result = true;
          return $breaker;
        }
      }

      self.$each();

      return result;
    
    };

    def.$inject = TMP_20 = function(object, sym) {
      var $a, self = this, $iter = TMP_20._p, block = $iter || nil;

      TMP_20._p = null;
      
      var result = object;

      if (block !== nil && sym === undefined) {
        self.$each._p = function() {
          var value = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if (result === undefined) {
            result = value;
            return;
          }

          value = $opal.$yieldX(block, [result, value]);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          result = value;
        };
      }
      else {
        if (sym === undefined) {
          if (!(($a = $scope.Symbol) == null ? $opal.cm('Symbol') : $a)['$==='](object)) {
            self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "" + (object.$inspect()) + " is not a Symbol");
          }

          sym    = object;
          result = undefined;
        }

        self.$each._p = function() {
          var value = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if (result === undefined) {
            result = value;
            return;
          }

          result = (result).$__send__(sym, value);
        };
      }

      self.$each();

      return result == undefined ? nil : result;
    ;
    };

    def.$lazy = function() {
      var $a, $b, TMP_21, $c, $d, self = this;

      return ($a = ($b = (($c = ((($d = $scope.Enumerator) == null ? $opal.cm('Enumerator') : $d))._scope).Lazy == null ? $c.cm('Lazy') : $c.Lazy)).$new, $a._p = (TMP_21 = function(enum$, args){var self = TMP_21._s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
      return ($a = enum$).$yield.apply($a, [].concat(args))}, TMP_21._s = self, TMP_21), $a).call($b, self, self.$enumerator_size());
    };

    def.$enumerator_size = function() {
      var $a, self = this;

      if ((($a = self['$respond_to?']("size")) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$size()
        } else {
        return nil
      };
    };

    self.$private("enumerator_size");

    $opal.defn(self, '$map', def.$collect);

    def.$max = TMP_22 = function() {
      var $a, self = this, $iter = TMP_22._p, block = $iter || nil;

      TMP_22._p = null;
      
      var result;

      if (block !== nil) {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          var value = block(param, result);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if (value === nil) {
            self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison failed");
          }

          if (value > 0) {
            result = param;
          }
        };
      }
      else {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          if ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$compare(param, result) > 0) {
            result = param;
          }
        };
      }

      self.$each();

      return result === undefined ? nil : result;
    
    };

    def.$max_by = TMP_23 = function() {
      var $a, self = this, $iter = TMP_23._p, block = $iter || nil;

      TMP_23._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("max_by")
      };
      
      var result,
          by;

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (result === undefined) {
          result = param;
          by     = value;
          return;
        }

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((value)['$<=>'](by) > 0) {
          result = param
          by     = value;
        }
      };

      self.$each();

      return result === undefined ? nil : result;
    
    };

    $opal.defn(self, '$member?', def['$include?']);

    def.$min = TMP_24 = function() {
      var $a, self = this, $iter = TMP_24._p, block = $iter || nil;

      TMP_24._p = null;
      
      var result;

      if (block !== nil) {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          var value = block(param, result);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if (value === nil) {
            self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison failed");
          }

          if (value < 0) {
            result = param;
          }
        };
      }
      else {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          if ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$compare(param, result) < 0) {
            result = param;
          }
        };
      }

      self.$each();

      return result === undefined ? nil : result;
    
    };

    def.$min_by = TMP_25 = function() {
      var $a, self = this, $iter = TMP_25._p, block = $iter || nil;

      TMP_25._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("min_by")
      };
      
      var result,
          by;

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (result === undefined) {
          result = param;
          by     = value;
          return;
        }

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((value)['$<=>'](by) < 0) {
          result = param
          by     = value;
        }
      };

      self.$each();

      return result === undefined ? nil : result;
    
    };

    def.$minmax = TMP_26 = function() {
      var $a, self = this, $iter = TMP_26._p, block = $iter || nil;

      TMP_26._p = null;
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def.$minmax_by = TMP_27 = function() {
      var $a, self = this, $iter = TMP_27._p, block = $iter || nil;

      TMP_27._p = null;
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def['$none?'] = TMP_28 = function() {
      var $a, self = this, $iter = TMP_28._p, block = $iter || nil;

      TMP_28._p = null;
      
      var result = true;

      if (block !== nil) {
        self.$each._p = function() {
          var value = $opal.$yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            result = false;
            return $breaker;
          }
        }
      }
      else {
        self.$each._p = function() {
          var value = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            result = false;
            return $breaker;
          }
        };
      }

      self.$each();

      return result;
    
    };

    def['$one?'] = TMP_29 = function() {
      var $a, self = this, $iter = TMP_29._p, block = $iter || nil;

      TMP_29._p = null;
      
      var result = false;

      if (block !== nil) {
        self.$each._p = function() {
          var value = $opal.$yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            if (result === true) {
              result = false;
              return $breaker;
            }

            result = true;
          }
        }
      }
      else {
        self.$each._p = function() {
          var value = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            if (result === true) {
              result = false;
              return $breaker;
            }

            result = true;
          }
        }
      }

      self.$each();

      return result;
    
    };

    def.$partition = TMP_30 = function() {
      var $a, self = this, $iter = TMP_30._p, block = $iter || nil;

      TMP_30._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("partition")
      };
      
      var truthy = [], falsy = [];

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
          truthy.push(param);
        }
        else {
          falsy.push(param);
        }
      };

      self.$each();

      return [truthy, falsy];
    
    };

    $opal.defn(self, '$reduce', def.$inject);

    def.$reject = TMP_31 = function() {
      var $a, self = this, $iter = TMP_31._p, block = $iter || nil;

      TMP_31._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reject")
      };
      
      var result = [];

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) === nil || ($a._isBoolean && $a == false))) {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    };

    def.$reverse_each = TMP_32 = function() {
      var self = this, $iter = TMP_32._p, block = $iter || nil;

      TMP_32._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reverse_each")
      };
      
      var result = [];

      self.$each._p = function() {
        result.push(arguments);
      };

      self.$each();

      for (var i = result.length - 1; i >= 0; i--) {
        $opal.$yieldX(block, result[i]);
      }

      return result;
    
    };

    $opal.defn(self, '$select', def.$find_all);

    def.$slice_before = TMP_33 = function(pattern) {
      var $a, $b, TMP_34, $c, self = this, $iter = TMP_33._p, block = $iter || nil;

      TMP_33._p = null;
      if ((($a = pattern === undefined && block === nil || arguments.length > 1) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "wrong number of arguments (" + (arguments.length) + " for 1)")};
      return ($a = ($b = (($c = $scope.Enumerator) == null ? $opal.cm('Enumerator') : $c)).$new, $a._p = (TMP_34 = function(e){var self = TMP_34._s || this, $a;
if (e == null) e = nil;
      
        var slice = [];

        if (block !== nil) {
          if (pattern === undefined) {
            self.$each._p = function() {
              var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
                  value = $opal.$yield1(block, param);

              if ((($a = value) !== nil && (!$a._isBoolean || $a == true)) && slice.length > 0) {
                e['$<<'](slice);
                slice = [];
              }

              slice.push(param);
            };
          }
          else {
            self.$each._p = function() {
              var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
                  value = block(param, pattern.$dup());

              if ((($a = value) !== nil && (!$a._isBoolean || $a == true)) && slice.length > 0) {
                e['$<<'](slice);
                slice = [];
              }

              slice.push(param);
            };
          }
        }
        else {
          self.$each._p = function() {
            var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
                value = pattern['$==='](param);

            if ((($a = value) !== nil && (!$a._isBoolean || $a == true)) && slice.length > 0) {
              e['$<<'](slice);
              slice = [];
            }

            slice.push(param);
          };
        }

        self.$each();

        if (slice.length > 0) {
          e['$<<'](slice);
        }
      ;}, TMP_34._s = self, TMP_34), $a).call($b);
    };

    def.$sort = TMP_35 = function() {
      var $a, self = this, $iter = TMP_35._p, block = $iter || nil;

      TMP_35._p = null;
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def.$sort_by = TMP_36 = function() {
      var $a, $b, TMP_37, $c, $d, TMP_38, $e, $f, TMP_39, self = this, $iter = TMP_36._p, block = $iter || nil;

      TMP_36._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("sort_by")
      };
      return ($a = ($b = ($c = ($d = ($e = ($f = self).$map, $e._p = (TMP_39 = function(){var self = TMP_39._s || this, $a;

      arg = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);
        return [block.$call(arg), arg];}, TMP_39._s = self, TMP_39), $e).call($f)).$sort, $c._p = (TMP_38 = function(a, b){var self = TMP_38._s || this;
if (a == null) a = nil;if (b == null) b = nil;
      return a['$[]'](0)['$<=>'](b['$[]'](0))}, TMP_38._s = self, TMP_38), $c).call($d)).$map, $a._p = (TMP_37 = function(arg){var self = TMP_37._s || this;
if (arg == null) arg = nil;
      return arg[1];}, TMP_37._s = self, TMP_37), $a).call($b);
    };

    def.$take = function(num) {
      var self = this;

      return self.$first(num);
    };

    def.$take_while = TMP_40 = function() {
      var $a, self = this, $iter = TMP_40._p, block = $iter || nil;

      TMP_40._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("take_while")
      };
      
      var result = [];

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) === nil || ($a._isBoolean && $a == false))) {
          return $breaker;
        }

        result.push(param);
      };

      self.$each();

      return result;
    
    };

    $opal.defn(self, '$to_a', def.$entries);

    def.$zip = TMP_41 = function(others) {
      var $a, self = this, $iter = TMP_41._p, block = $iter || nil;

      others = $slice.call(arguments, 0);
      TMP_41._p = null;
      return ($a = self.$to_a()).$zip.apply($a, [].concat(others));
    };
        ;$opal.donate(self, ["$all?", "$any?", "$chunk", "$collect", "$collect_concat", "$count", "$cycle", "$detect", "$drop", "$drop_while", "$each_cons", "$each_entry", "$each_slice", "$each_with_index", "$each_with_object", "$entries", "$find", "$find_all", "$find_index", "$first", "$flat_map", "$grep", "$group_by", "$include?", "$inject", "$lazy", "$enumerator_size", "$map", "$max", "$max_by", "$member?", "$min", "$min_by", "$minmax", "$minmax_by", "$none?", "$one?", "$partition", "$reduce", "$reject", "$reverse_each", "$select", "$slice_before", "$sort", "$sort_by", "$take", "$take_while", "$to_a", "$zip"]);
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/enumerable.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$allocate', '$new', '$to_proc', '$coerce_to', '$nil?', '$empty?', '$+', '$class', '$__send__', '$===', '$call', '$enum_for', '$destructure', '$name', '$inspect', '$[]', '$raise', '$yield', '$each', '$enumerator_size', '$respond_to?', '$try_convert', '$<', '$for']);
  ;
  return (function($base, $super) {
    function $Enumerator(){};
    var self = $Enumerator = $klass($base, $super, 'Enumerator', $Enumerator);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3, TMP_4;

    def.size = def.args = def.object = def.method = nil;
    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    $opal.defs(self, '$for', TMP_1 = function(object, method, args) {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      args = $slice.call(arguments, 2);
      if (method == null) {
        method = "each"
      }
      TMP_1._p = null;
      
      var obj = self.$allocate();

      obj.object = object;
      obj.size   = block;
      obj.method = method;
      obj.args   = args;

      return obj;
    ;
    });

    def.$initialize = TMP_2 = function() {
      var $a, $b, $c, self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      if (block !== false && block !== nil) {
        self.object = ($a = ($b = (($c = $scope.Generator) == null ? $opal.cm('Generator') : $c)).$new, $a._p = block.$to_proc(), $a).call($b);
        self.method = "each";
        self.args = [];
        self.size = arguments[0] || nil;
        if ((($a = self.size) !== nil && (!$a._isBoolean || $a == true))) {
          return self.size = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(self.size, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
          } else {
          return nil
        };
        } else {
        self.object = arguments[0];
        self.method = arguments[1] || "each";
        self.args = $slice.call(arguments, 2);
        return self.size = nil;
      };
    };

    def.$each = TMP_3 = function(args) {
      var $a, $b, $c, self = this, $iter = TMP_3._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_3._p = null;
      if ((($a = ($b = block['$nil?'](), $b !== false && $b !== nil ?args['$empty?']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return self};
      args = self.args['$+'](args);
      if ((($a = block['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
        return ($a = self.$class()).$new.apply($a, [self.object, self.method].concat(args))};
      return ($b = ($c = self.object).$__send__, $b._p = block.$to_proc(), $b).apply($c, [self.method].concat(args));
    };

    def.$size = function() {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Proc) == null ? $opal.cm('Proc') : $b)['$==='](self.size)) !== nil && (!$a._isBoolean || $a == true))) {
        return ($a = self.size).$call.apply($a, [].concat(self.args))
        } else {
        return self.size
      };
    };

    def.$with_index = TMP_4 = function(offset) {
      var $a, self = this, $iter = TMP_4._p, block = $iter || nil;

      if (offset == null) {
        offset = 0
      }
      TMP_4._p = null;
      if (offset !== false && offset !== nil) {
        offset = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(offset, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
        } else {
        offset = 0
      };
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("with_index", offset)
      };
      
      var result

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = block(param, index);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        index++;
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }
    ;
    };

    $opal.defn(self, '$with_object', def.$each_with_object);

    def.$inspect = function() {
      var $a, self = this, result = nil;

      result = "#<" + (self.$class().$name()) + ": " + (self.object.$inspect()) + ":" + (self.method);
      if ((($a = self.args['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        result = result['$+']("(" + (self.args.$inspect()['$[]']((($a = $scope.Range) == null ? $opal.cm('Range') : $a).$new(1, -2))) + ")")
      };
      return result['$+'](">");
    };

    (function($base, $super) {
      function $Generator(){};
      var self = $Generator = $klass($base, $super, 'Generator', $Generator);

      var def = self._proto, $scope = self._scope, $a, TMP_5, TMP_6;

      def.block = nil;
      self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

      def.$initialize = TMP_5 = function() {
        var $a, self = this, $iter = TMP_5._p, block = $iter || nil;

        TMP_5._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.LocalJumpError) == null ? $opal.cm('LocalJumpError') : $a), "no block given")
        };
        return self.block = block;
      };

      return (def.$each = TMP_6 = function(args) {
        var $a, $b, $c, self = this, $iter = TMP_6._p, block = $iter || nil, yielder = nil;

        args = $slice.call(arguments, 0);
        TMP_6._p = null;
        yielder = ($a = ($b = (($c = $scope.Yielder) == null ? $opal.cm('Yielder') : $c)).$new, $a._p = block.$to_proc(), $a).call($b);
        
        try {
          args.unshift(yielder);

          if ($opal.$yieldX(self.block, args) === $breaker) {
            return $breaker.$v;
          }
        }
        catch (e) {
          if (e === $breaker) {
            return $breaker.$v;
          }
          else {
            throw e;
          }
        }
      ;
        return self;
      }, nil) && 'each';
    })(self, null);

    (function($base, $super) {
      function $Yielder(){};
      var self = $Yielder = $klass($base, $super, 'Yielder', $Yielder);

      var def = self._proto, $scope = self._scope, TMP_7;

      def.block = nil;
      def.$initialize = TMP_7 = function() {
        var self = this, $iter = TMP_7._p, block = $iter || nil;

        TMP_7._p = null;
        return self.block = block;
      };

      def.$yield = function(values) {
        var self = this;

        values = $slice.call(arguments, 0);
        
        var value = $opal.$yieldX(self.block, values);

        if (value === $breaker) {
          throw $breaker;
        }

        return value;
      ;
      };

      return (def['$<<'] = function(values) {
        var $a, self = this;

        values = $slice.call(arguments, 0);
        ($a = self).$yield.apply($a, [].concat(values));
        return self;
      }, nil) && '<<';
    })(self, null);

    return (function($base, $super) {
      function $Lazy(){};
      var self = $Lazy = $klass($base, $super, 'Lazy', $Lazy);

      var def = self._proto, $scope = self._scope, $a, TMP_8, TMP_11, TMP_13, TMP_18, TMP_20, TMP_21, TMP_23, TMP_26, TMP_29;

      def.enumerator = nil;
      (function($base, $super) {
        function $StopLazyError(){};
        var self = $StopLazyError = $klass($base, $super, 'StopLazyError', $StopLazyError);

        var def = self._proto, $scope = self._scope;

        return nil;
      })(self, (($a = $scope.Exception) == null ? $opal.cm('Exception') : $a));

      def.$initialize = TMP_8 = function(object, size) {
        var $a, TMP_9, self = this, $iter = TMP_8._p, block = $iter || nil;

        if (size == null) {
          size = nil
        }
        TMP_8._p = null;
        if ((block !== nil)) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy new without a block")
        };
        self.enumerator = object;
        return $opal.find_super_dispatcher(self, 'initialize', TMP_8, (TMP_9 = function(yielder, each_args){var self = TMP_9._s || this, $a, $b, TMP_10;
if (yielder == null) yielder = nil;each_args = $slice.call(arguments, 1);
        try {
          return ($a = ($b = object).$each, $a._p = (TMP_10 = function(args){var self = TMP_10._s || this;
args = $slice.call(arguments, 0);
            
              args.unshift(yielder);

              if ($opal.$yieldX(block, args) === $breaker) {
                return $breaker;
              }
            ;}, TMP_10._s = self, TMP_10), $a).apply($b, [].concat(each_args))
          } catch ($err) {if ($opal.$rescue($err, [(($a = $scope.Exception) == null ? $opal.cm('Exception') : $a)])) {
            return nil
            }else { throw $err; }
          }}, TMP_9._s = self, TMP_9)).apply(self, [size]);
      };

      $opal.defn(self, '$force', def.$to_a);

      def.$lazy = function() {
        var self = this;

        return self;
      };

      def.$collect = TMP_11 = function() {
        var $a, $b, TMP_12, $c, self = this, $iter = TMP_11._p, block = $iter || nil;

        TMP_11._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy map without a block")
        };
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_12 = function(enum$, args){var self = TMP_12._s || this;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = $opal.$yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          enum$.$yield(value);
        }, TMP_12._s = self, TMP_12), $a).call($b, self, self.$enumerator_size());
      };

      def.$collect_concat = TMP_13 = function() {
        var $a, $b, TMP_14, $c, self = this, $iter = TMP_13._p, block = $iter || nil;

        TMP_13._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy map without a block")
        };
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_14 = function(enum$, args){var self = TMP_14._s || this, $a, $b, TMP_15, $c, TMP_16;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = $opal.$yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((value)['$respond_to?']("force") && (value)['$respond_to?']("each")) {
            ($a = ($b = (value)).$each, $a._p = (TMP_15 = function(v){var self = TMP_15._s || this;
if (v == null) v = nil;
          return enum$.$yield(v)}, TMP_15._s = self, TMP_15), $a).call($b)
          }
          else {
            var array = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$try_convert(value, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary");

            if (array === nil) {
              enum$.$yield(value);
            }
            else {
              ($a = ($c = (value)).$each, $a._p = (TMP_16 = function(v){var self = TMP_16._s || this;
if (v == null) v = nil;
          return enum$.$yield(v)}, TMP_16._s = self, TMP_16), $a).call($c);
            }
          }
        ;}, TMP_14._s = self, TMP_14), $a).call($b, self, nil);
      };

      def.$drop = function(n) {
        var $a, $b, TMP_17, $c, self = this, current_size = nil, set_size = nil, dropped = nil;

        n = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(n, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if (n['$<'](0)) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "attempt to drop negative size")};
        current_size = self.$enumerator_size();
        set_size = (function() {if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](current_size)) !== nil && (!$a._isBoolean || $a == true))) {
          if (n['$<'](current_size)) {
            return n
            } else {
            return current_size
          }
          } else {
          return current_size
        }; return nil; })();
        dropped = 0;
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_17 = function(enum$, args){var self = TMP_17._s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        if (dropped['$<'](n)) {
            return dropped = dropped['$+'](1)
            } else {
            return ($a = enum$).$yield.apply($a, [].concat(args))
          }}, TMP_17._s = self, TMP_17), $a).call($b, self, set_size);
      };

      def.$drop_while = TMP_18 = function() {
        var $a, $b, TMP_19, $c, self = this, $iter = TMP_18._p, block = $iter || nil, succeeding = nil;

        TMP_18._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy drop_while without a block")
        };
        succeeding = true;
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_19 = function(enum$, args){var self = TMP_19._s || this, $a, $b;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        if (succeeding !== false && succeeding !== nil) {
            
            var value = $opal.$yieldX(block, args);

            if (value === $breaker) {
              return $breaker;
            }

            if ((($a = value) === nil || ($a._isBoolean && $a == false))) {
              succeeding = false;

              ($a = enum$).$yield.apply($a, [].concat(args));
            }
          
            } else {
            return ($b = enum$).$yield.apply($b, [].concat(args))
          }}, TMP_19._s = self, TMP_19), $a).call($b, self, nil);
      };

      def.$enum_for = TMP_20 = function(method, args) {
        var $a, $b, self = this, $iter = TMP_20._p, block = $iter || nil;

        args = $slice.call(arguments, 1);
        if (method == null) {
          method = "each"
        }
        TMP_20._p = null;
        return ($a = ($b = self.$class()).$for, $a._p = block.$to_proc(), $a).apply($b, [self, method].concat(args));
      };

      def.$find_all = TMP_21 = function() {
        var $a, $b, TMP_22, $c, self = this, $iter = TMP_21._p, block = $iter || nil;

        TMP_21._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy select without a block")
        };
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_22 = function(enum$, args){var self = TMP_22._s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = $opal.$yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            ($a = enum$).$yield.apply($a, [].concat(args));
          }
        ;}, TMP_22._s = self, TMP_22), $a).call($b, self, nil);
      };

      $opal.defn(self, '$flat_map', def.$collect_concat);

      def.$grep = TMP_23 = function(pattern) {
        var $a, $b, TMP_24, $c, TMP_25, $d, self = this, $iter = TMP_23._p, block = $iter || nil;

        TMP_23._p = null;
        if (block !== false && block !== nil) {
          return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_24 = function(enum$, args){var self = TMP_24._s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
          
            var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(args),
                value = pattern['$==='](param);

            if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
              value = $opal.$yield1(block, param);

              if (value === $breaker) {
                return $breaker;
              }

              enum$.$yield($opal.$yield1(block, param));
            }
          ;}, TMP_24._s = self, TMP_24), $a).call($b, self, nil)
          } else {
          return ($a = ($c = (($d = $scope.Lazy) == null ? $opal.cm('Lazy') : $d)).$new, $a._p = (TMP_25 = function(enum$, args){var self = TMP_25._s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
          
            var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(args),
                value = pattern['$==='](param);

            if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
              enum$.$yield(param);
            }
          ;}, TMP_25._s = self, TMP_25), $a).call($c, self, nil)
        };
      };

      $opal.defn(self, '$map', def.$collect);

      $opal.defn(self, '$select', def.$find_all);

      def.$reject = TMP_26 = function() {
        var $a, $b, TMP_27, $c, self = this, $iter = TMP_26._p, block = $iter || nil;

        TMP_26._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy reject without a block")
        };
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_27 = function(enum$, args){var self = TMP_27._s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = $opal.$yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((($a = value) === nil || ($a._isBoolean && $a == false))) {
            ($a = enum$).$yield.apply($a, [].concat(args));
          }
        ;}, TMP_27._s = self, TMP_27), $a).call($b, self, nil);
      };

      def.$take = function(n) {
        var $a, $b, TMP_28, $c, self = this, current_size = nil, set_size = nil, taken = nil;

        n = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(n, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if (n['$<'](0)) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "attempt to take negative size")};
        current_size = self.$enumerator_size();
        set_size = (function() {if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](current_size)) !== nil && (!$a._isBoolean || $a == true))) {
          if (n['$<'](current_size)) {
            return n
            } else {
            return current_size
          }
          } else {
          return current_size
        }; return nil; })();
        taken = 0;
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_28 = function(enum$, args){var self = TMP_28._s || this, $a, $b;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        if (taken['$<'](n)) {
            ($a = enum$).$yield.apply($a, [].concat(args));
            return taken = taken['$+'](1);
            } else {
            return self.$raise((($b = $scope.StopLazyError) == null ? $opal.cm('StopLazyError') : $b))
          }}, TMP_28._s = self, TMP_28), $a).call($b, self, set_size);
      };

      def.$take_while = TMP_29 = function() {
        var $a, $b, TMP_30, $c, self = this, $iter = TMP_29._p, block = $iter || nil;

        TMP_29._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy take_while without a block")
        };
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_30 = function(enum$, args){var self = TMP_30._s || this, $a, $b;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = $opal.$yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            ($a = enum$).$yield.apply($a, [].concat(args));
          }
          else {
            self.$raise((($b = $scope.StopLazyError) == null ? $opal.cm('StopLazyError') : $b));
          }
        ;}, TMP_30._s = self, TMP_30), $a).call($b, self, nil);
      };

      $opal.defn(self, '$to_enum', def.$enum_for);

      return (def.$inspect = function() {
        var self = this;

        return "#<" + (self.$class().$name()) + ": " + (self.enumerator.$inspect()) + ">";
      }, nil) && 'inspect';
    })(self, self);
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/enumerator.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $gvars = $opal.gvars, $range = $opal.range;

  $opal.add_stubs(['$include', '$new', '$class', '$raise', '$===', '$to_a', '$respond_to?', '$to_ary', '$coerce_to', '$coerce_to?', '$==', '$to_str', '$clone', '$hash', '$<=>', '$inspect', '$empty?', '$enum_for', '$nil?', '$coerce_to!', '$initialize_clone', '$initialize_dup', '$replace', '$eql?', '$length', '$begin', '$end', '$exclude_end?', '$flatten', '$object_id', '$[]', '$to_s', '$join', '$delete_if', '$to_proc', '$each', '$reverse', '$!', '$map', '$rand', '$keep_if', '$shuffle!', '$>', '$<', '$sort', '$times', '$[]=', '$<<', '$at']);
  ;
  return (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_17, TMP_18, TMP_19, TMP_20, TMP_21, TMP_24;

    def.length = nil;
    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    def._isArray = true;

    $opal.defs(self, '$[]', function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      return objects;
    });

    def.$initialize = function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      return ($a = self.$class()).$new.apply($a, [].concat(args));
    };

    $opal.defs(self, '$new', TMP_1 = function(size, obj) {
      var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil;

      if (size == null) {
        size = nil
      }
      if (obj == null) {
        obj = nil
      }
      TMP_1._p = null;
      if ((($a = arguments.length > 2) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "wrong number of arguments (" + (arguments.length) + " for 0..2)")};
      if ((($a = arguments.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return []};
      if ((($a = arguments.length === 1) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](size)) !== nil && (!$a._isBoolean || $a == true))) {
          return size.$to_a()
        } else if ((($a = size['$respond_to?']("to_ary")) !== nil && (!$a._isBoolean || $a == true))) {
          return size.$to_ary()}};
      size = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(size, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      if ((($a = size < 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "negative array size")};
      
      var result = [];

      if (block === nil) {
        for (var i = 0; i < size; i++) {
          result.push(obj);
        }
      }
      else {
        for (var i = 0, value; i < size; i++) {
          value = block(i);

          if (value === $breaker) {
            return $breaker.$v;
          }

          result[i] = value;
        }
      }

      return result;
    
    });

    $opal.defs(self, '$try_convert', function(obj) {
      var $a, self = this;

      return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to?'](obj, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary");
    });

    def['$&'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary").$to_a()
      };
      
      var result = [],
          seen   = {};

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if (!seen[item]) {
          for (var j = 0, length2 = other.length; j < length2; j++) {
            var item2 = other[j];

            if (!seen[item2] && (item)['$=='](item2)) {
              seen[item] = true;
              result.push(item);
            }
          }
        }
      }

      return result;
    
    };

    def['$*'] = function(other) {
      var $a, self = this;

      if ((($a = other['$respond_to?']("to_str")) !== nil && (!$a._isBoolean || $a == true))) {
        return self.join(other.$to_str())};
      if ((($a = other['$respond_to?']("to_int")) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "no implicit conversion of " + (other.$class()) + " into Integer")
      };
      other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      if ((($a = other < 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "negative argument")};
      
      var result = [];

      for (var i = 0; i < other; i++) {
        result = result.concat(self);
      }

      return result;
    
    };

    def['$+'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary").$to_a()
      };
      return self.concat(other);
    };

    def['$-'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary").$to_a()
      };
      if ((($a = self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return []};
      if ((($a = other.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$clone()};
      
      var seen   = {},
          result = [];

      for (var i = 0, length = other.length; i < length; i++) {
        seen[other[i]] = true;
      }

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if (!seen[item]) {
          result.push(item);
        }
      }

      return result;
    
    };

    def['$<<'] = function(object) {
      var self = this;

      self.push(object);
      return self;
    };

    def['$<=>'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_a()
      } else if ((($a = other['$respond_to?']("to_ary")) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_ary().$to_a()
        } else {
        return nil
      };
      
      if (self.$hash() === other.$hash()) {
        return 0;
      }

      if (self.length != other.length) {
        return (self.length > other.length) ? 1 : -1;
      }

      for (var i = 0, length = self.length; i < length; i++) {
        var tmp = (self[i])['$<=>'](other[i]);

        if (tmp !== 0) {
          return tmp;
        }
      }

      return 0;
    ;
    };

    def['$=='] = function(other) {
      var $a, $b, self = this;

      if ((($a = self === other) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        if ((($a = other['$respond_to?']("to_ary")) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          return false
        };
        return other['$=='](self);
      };
      other = other.$to_a();
      if ((($a = self.length === other.length) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var a = self[i],
            b = other[i];

        if (a._isArray && b._isArray && (a === self)) {
          continue;
        }

        if (!(a)['$=='](b)) {
          return false;
        }
      }
    
      return true;
    };

    def['$[]'] = function(index, length) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Range) == null ? $opal.cm('Range') : $b)['$==='](index)) !== nil && (!$a._isBoolean || $a == true))) {
        
        var size    = self.length,
            exclude = index.exclude,
            from    = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index.begin, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int"),
            to      = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index.end, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

        if (from < 0) {
          from += size;

          if (from < 0) {
            return nil;
          }
        }

        if (from > size) {
          return nil;
        }

        if (to < 0) {
          to += size;

          if (to < 0) {
            return [];
          }
        }

        if (!exclude) {
          to += 1;
        }

        return self.slice(from, to);
      ;
        } else {
        index = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        
        var size = self.length;

        if (index < 0) {
          index += size;

          if (index < 0) {
            return nil;
          }
        }

        if (length === undefined) {
          if (index >= size || index < 0) {
            return nil;
          }

          return self[index];
        }
        else {
          length = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(length, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

          if (length < 0 || index > size || index < 0) {
            return nil;
          }

          return self.slice(index, index + length);
        }
      
      };
    };

    def['$[]='] = function(index, value, extra) {
      var $a, $b, self = this, data = nil, length = nil;

      if ((($a = (($b = $scope.Range) == null ? $opal.cm('Range') : $b)['$==='](index)) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
          data = value.$to_a()
        } else if ((($a = value['$respond_to?']("to_ary")) !== nil && (!$a._isBoolean || $a == true))) {
          data = value.$to_ary().$to_a()
          } else {
          data = [value]
        };
        
        var size    = self.length,
            exclude = index.exclude,
            from    = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index.begin, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int"),
            to      = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index.end, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

        if (from < 0) {
          from += size;

          if (from < 0) {
            self.$raise((($a = $scope.RangeError) == null ? $opal.cm('RangeError') : $a), "" + (index.$inspect()) + " out of range");
          }
        }

        if (to < 0) {
          to += size;
        }

        if (!exclude) {
          to += 1;
        }

        if (from > size) {
          for (var i = size; i < from; i++) {
            self[i] = nil;
          }
        }

        if (to < 0) {
          self.splice.apply(self, [from, 0].concat(data));
        }
        else {
          self.splice.apply(self, [from, to - from].concat(data));
        }

        return value;
      ;
        } else {
        if ((($a = extra === undefined) !== nil && (!$a._isBoolean || $a == true))) {
          length = 1
          } else {
          length = value;
          value = extra;
          if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
            data = value.$to_a()
          } else if ((($a = value['$respond_to?']("to_ary")) !== nil && (!$a._isBoolean || $a == true))) {
            data = value.$to_ary().$to_a()
            } else {
            data = [value]
          };
        };
        
        var size   = self.length,
            index  = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int"),
            length = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(length, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int"),
            old;

        if (index < 0) {
          old    = index;
          index += size;

          if (index < 0) {
            self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "index " + (old) + " too small for array; minimum " + (-self.length));
          }
        }

        if (length < 0) {
          self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "negative length (" + (length) + ")")
        }

        if (index > size) {
          for (var i = size; i < index; i++) {
            self[i] = nil;
          }
        }

        if (extra === undefined) {
          self[index] = value;
        }
        else {
          self.splice.apply(self, [index, length].concat(data));
        }

        return value;
      ;
      };
    };

    def.$assoc = function(object) {
      var self = this;

      
      for (var i = 0, length = self.length, item; i < length; i++) {
        if (item = self[i], item.length && (item[0])['$=='](object)) {
          return item;
        }
      }

      return nil;
    
    };

    def.$at = function(index) {
      var $a, self = this;

      index = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      
      if (index < 0) {
        index += self.length;
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      return self[index];
    
    };

    def.$cycle = TMP_2 = function(n) {
      var $a, $b, self = this, $iter = TMP_2._p, block = $iter || nil;

      if (n == null) {
        n = nil
      }
      TMP_2._p = null;
      if ((($a = ((($b = self['$empty?']()) !== false && $b !== nil) ? $b : n['$=='](0))) !== nil && (!$a._isBoolean || $a == true))) {
        return nil};
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("cycle", n)
      };
      if ((($a = n['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
        
        while (true) {
          for (var i = 0, length = self.length; i < length; i++) {
            var value = $opal.$yield1(block, self[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }
        }
      
        } else {
        n = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](n, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        
        if (n <= 0) {
          return self;
        }

        while (n > 0) {
          for (var i = 0, length = self.length; i < length; i++) {
            var value = $opal.$yield1(block, self[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }

          n--;
        }
      
      };
      return self;
    };

    def.$clear = function() {
      var self = this;

      self.splice(0, self.length);
      return self;
    };

    def.$clone = function() {
      var self = this, copy = nil;

      copy = [];
      copy.$initialize_clone(self);
      return copy;
    };

    def.$dup = function() {
      var self = this, copy = nil;

      copy = [];
      copy.$initialize_dup(self);
      return copy;
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return self.$replace(other);
    };

    def.$collect = TMP_3 = function() {
      var self = this, $iter = TMP_3._p, block = $iter || nil;

      TMP_3._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect")
      };
      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.$yield1(block, self[i]);

        if (value === $breaker) {
          return $breaker.$v;
        }

        result.push(value);
      }

      return result;
    
    };

    def['$collect!'] = TMP_4 = function() {
      var self = this, $iter = TMP_4._p, block = $iter || nil;

      TMP_4._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect!")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.$yield1(block, self[i]);

        if (value === $breaker) {
          return $breaker.$v;
        }

        self[i] = value;
      }
    
      return self;
    };

    def.$compact = function() {
      var self = this;

      
      var result = [];

      for (var i = 0, length = self.length, item; i < length; i++) {
        if ((item = self[i]) !== nil) {
          result.push(item);
        }
      }

      return result;
    
    };

    def['$compact!'] = function() {
      var self = this;

      
      var original = self.length;

      for (var i = 0, length = self.length; i < length; i++) {
        if (self[i] === nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      return self.length === original ? nil : self;
    
    };

    def.$concat = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary").$to_a()
      };
      
      for (var i = 0, length = other.length; i < length; i++) {
        self.push(other[i]);
      }
    
      return self;
    };

    def.$delete = function(object) {
      var self = this;

      
      var original = self.length;

      for (var i = 0, length = original; i < length; i++) {
        if ((self[i])['$=='](object)) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      return self.length === original ? nil : object;
    
    };

    def.$delete_at = function(index) {
      var $a, self = this;

      
      index = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

      if (index < 0) {
        index += self.length;
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      var result = self[index];

      self.splice(index, 1);

      return result;
    ;
    };

    def.$delete_if = TMP_5 = function() {
      var self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("delete_if")
      };
      
      for (var i = 0, length = self.length, value; i < length; i++) {
        if ((value = block(self[i])) === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }
    
      return self;
    };

    def.$drop = function(number) {
      var $a, self = this;

      
      if (number < 0) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a))
      }

      return self.slice(number);
    ;
    };

    $opal.defn(self, '$dup', def.$clone);

    def.$each = TMP_6 = function() {
      var self = this, $iter = TMP_6._p, block = $iter || nil;

      TMP_6._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = $opal.$yield1(block, self[i]);

        if (value == $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def.$each_index = TMP_7 = function() {
      var self = this, $iter = TMP_7._p, block = $iter || nil;

      TMP_7._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_index")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = $opal.$yield1(block, i);

        if (value === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def['$empty?'] = function() {
      var self = this;

      return self.length === 0;
    };

    def['$eql?'] = function(other) {
      var $a, $b, self = this;

      if ((($a = self === other) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      other = other.$to_a();
      if ((($a = self.length === other.length) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var a = self[i],
            b = other[i];

        if (a._isArray && b._isArray && (a === self)) {
          continue;
        }

        if (!(a)['$eql?'](b)) {
          return false;
        }
      }
    
      return true;
    };

    def.$fetch = TMP_8 = function(index, defaults) {
      var $a, self = this, $iter = TMP_8._p, block = $iter || nil;

      TMP_8._p = null;
      
      var original = index;

      index = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

      if (index < 0) {
        index += self.length;
      }

      if (index >= 0 && index < self.length) {
        return self[index];
      }

      if (block !== nil) {
        return block(original);
      }

      if (defaults != null) {
        return defaults;
      }

      if (self.length === 0) {
        self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "index " + (original) + " outside of array bounds: 0...0")
      }
      else {
        self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "index " + (original) + " outside of array bounds: -" + (self.length) + "..." + (self.length));
      }
    ;
    };

    def.$fill = TMP_9 = function(args) {
      var $a, $b, self = this, $iter = TMP_9._p, block = $iter || nil, one = nil, two = nil, obj = nil, left = nil, right = nil;

      args = $slice.call(arguments, 0);
      TMP_9._p = null;
      if (block !== false && block !== nil) {
        if ((($a = args.length > 2) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "wrong number of arguments (" + (args.$length()) + " for 0..2)")};
        $a = $opal.to_ary(args), one = ($a[0] == null ? nil : $a[0]), two = ($a[1] == null ? nil : $a[1]);
        } else {
        if ((($a = args.length == 0) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "wrong number of arguments (0 for 1..3)")
        } else if ((($a = args.length > 3) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "wrong number of arguments (" + (args.$length()) + " for 1..3)")};
        $a = $opal.to_ary(args), obj = ($a[0] == null ? nil : $a[0]), one = ($a[1] == null ? nil : $a[1]), two = ($a[2] == null ? nil : $a[2]);
      };
      if ((($a = (($b = $scope.Range) == null ? $opal.cm('Range') : $b)['$==='](one)) !== nil && (!$a._isBoolean || $a == true))) {
        if (two !== false && two !== nil) {
          self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "length invalid with range")};
        left = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(one.$begin(), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if ((($a = left < 0) !== nil && (!$a._isBoolean || $a == true))) {
          left += self.length;};
        if ((($a = left < 0) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.RangeError) == null ? $opal.cm('RangeError') : $a), "" + (one.$inspect()) + " out of range")};
        right = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(one.$end(), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if ((($a = right < 0) !== nil && (!$a._isBoolean || $a == true))) {
          right += self.length;};
        if ((($a = one['$exclude_end?']()) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          right += 1;
        };
        if ((($a = right <= left) !== nil && (!$a._isBoolean || $a == true))) {
          return self};
      } else if (one !== false && one !== nil) {
        left = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(one, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if ((($a = left < 0) !== nil && (!$a._isBoolean || $a == true))) {
          left += self.length;};
        if ((($a = left < 0) !== nil && (!$a._isBoolean || $a == true))) {
          left = 0};
        if (two !== false && two !== nil) {
          right = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(two, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
          if ((($a = right == 0) !== nil && (!$a._isBoolean || $a == true))) {
            return self};
          right += left;
          } else {
          right = self.length
        };
        } else {
        left = 0;
        right = self.length;
      };
      if ((($a = left > self.length) !== nil && (!$a._isBoolean || $a == true))) {
        
        for (var i = self.length; i < right; i++) {
          self[i] = nil;
        }
      ;};
      if ((($a = right > self.length) !== nil && (!$a._isBoolean || $a == true))) {
        self.length = right};
      if (block !== false && block !== nil) {
        
        for (var length = self.length; left < right; left++) {
          var value = block(left);

          if (value === $breaker) {
            return $breaker.$v;
          }

          self[left] = value;
        }
      ;
        } else {
        
        for (var length = self.length; left < right; left++) {
          self[left] = obj;
        }
      ;
      };
      return self;
    };

    def.$first = function(count) {
      var $a, self = this;

      
      if (count == null) {
        return self.length === 0 ? nil : self[0];
      }

      count = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(count, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

      if (count < 0) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "negative array size");
      }

      return self.slice(0, count);
    
    };

    def.$flatten = function(level) {
      var $a, self = this;

      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$respond_to?'](item, "to_ary")) {
          item = (item).$to_ary();

          if (level == null) {
            result.push.apply(result, (item).$flatten().$to_a());
          }
          else if (level == 0) {
            result.push(item);
          }
          else {
            result.push.apply(result, (item).$flatten(level - 1).$to_a());
          }
        }
        else {
          result.push(item);
        }
      }

      return result;
    ;
    };

    def['$flatten!'] = function(level) {
      var self = this;

      
      var flattened = self.$flatten(level);

      if (self.length == flattened.length) {
        for (var i = 0, length = self.length; i < length; i++) {
          if (self[i] !== flattened[i]) {
            break;
          }
        }

        if (i == length) {
          return nil;
        }
      }

      self.$replace(flattened);
    ;
      return self;
    };

    def.$hash = function() {
      var self = this;

      return self._id || (self._id = Opal.uid());
    };

    def['$include?'] = function(member) {
      var self = this;

      
      for (var i = 0, length = self.length; i < length; i++) {
        if ((self[i])['$=='](member)) {
          return true;
        }
      }

      return false;
    
    };

    def.$index = TMP_10 = function(object) {
      var self = this, $iter = TMP_10._p, block = $iter || nil;

      TMP_10._p = null;
      
      if (object != null) {
        for (var i = 0, length = self.length; i < length; i++) {
          if ((self[i])['$=='](object)) {
            return i;
          }
        }
      }
      else if (block !== nil) {
        for (var i = 0, length = self.length, value; i < length; i++) {
          if ((value = block(self[i])) === $breaker) {
            return $breaker.$v;
          }

          if (value !== false && value !== nil) {
            return i;
          }
        }
      }
      else {
        return self.$enum_for("index");
      }

      return nil;
    
    };

    def.$insert = function(index, objects) {
      var $a, self = this;

      objects = $slice.call(arguments, 1);
      
      index = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

      if (objects.length > 0) {
        if (index < 0) {
          index += self.length + 1;

          if (index < 0) {
            self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "" + (index) + " is out of bounds");
          }
        }
        if (index > self.length) {
          for (var i = self.length; i < index; i++) {
            self.push(nil);
          }
        }

        self.splice.apply(self, [index, 0].concat(objects));
      }
    ;
      return self;
    };

    def.$inspect = function() {
      var self = this;

      
      var i, inspect, el, el_insp, length, object_id;

      inspect = [];
      object_id = self.$object_id();
      length = self.length;

      for (i = 0; i < length; i++) {
        el = self['$[]'](i);

        // Check object_id to ensure it's not the same array get into an infinite loop
        el_insp = (el).$object_id() === object_id ? '[...]' : (el).$inspect();

        inspect.push(el_insp);
      }
      return '[' + inspect.join(', ') + ']';
    ;
    };

    def.$join = function(sep) {
      var $a, self = this;
      if ($gvars[","] == null) $gvars[","] = nil;

      if (sep == null) {
        sep = nil
      }
      if ((($a = self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return ""};
      if ((($a = sep === nil) !== nil && (!$a._isBoolean || $a == true))) {
        sep = $gvars[","]};
      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$respond_to?'](item, "to_str")) {
          var tmp = (item).$to_str();

          if (tmp !== nil) {
            result.push((tmp).$to_s());

            continue;
          }
        }

        if ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$respond_to?'](item, "to_ary")) {
          var tmp = (item).$to_ary();

          if (tmp !== nil) {
            result.push((tmp).$join(sep));

            continue;
          }
        }

        if ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$respond_to?'](item, "to_s")) {
          var tmp = (item).$to_s();

          if (tmp !== nil) {
            result.push(tmp);

            continue;
          }
        }

        self.$raise((($a = $scope.NoMethodError) == null ? $opal.cm('NoMethodError') : $a), "" + ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$inspect(item)) + " doesn't respond to #to_str, #to_ary or #to_s");
      }

      if (sep === nil) {
        return result.join('');
      }
      else {
        return result.join((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](sep, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s());
      }
    ;
    };

    def.$keep_if = TMP_11 = function() {
      var self = this, $iter = TMP_11._p, block = $iter || nil;

      TMP_11._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("keep_if")
      };
      
      for (var i = 0, length = self.length, value; i < length; i++) {
        if ((value = block(self[i])) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }
    
      return self;
    };

    def.$last = function(count) {
      var $a, self = this;

      
      if (count == null) {
        return self.length === 0 ? nil : self[self.length - 1];
      }

      count = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(count, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

      if (count < 0) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "negative array size");
      }

      if (count > self.length) {
        count = self.length;
      }

      return self.slice(self.length - count, self.length);
    
    };

    def.$length = function() {
      var self = this;

      return self.length;
    };

    $opal.defn(self, '$map', def.$collect);

    $opal.defn(self, '$map!', def['$collect!']);

    def.$pop = function(count) {
      var $a, self = this;

      if ((($a = count === undefined) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
          return nil};
        return self.pop();};
      count = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(count, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      if ((($a = count < 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "negative array size")};
      if ((($a = self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return []};
      if ((($a = count > self.length) !== nil && (!$a._isBoolean || $a == true))) {
        return self.splice(0, self.length);
        } else {
        return self.splice(self.length - count, self.length);
      };
    };

    def.$push = function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      
      for (var i = 0, length = objects.length; i < length; i++) {
        self.push(objects[i]);
      }
    
      return self;
    };

    def.$rassoc = function(object) {
      var self = this;

      
      for (var i = 0, length = self.length, item; i < length; i++) {
        item = self[i];

        if (item.length && item[1] !== undefined) {
          if ((item[1])['$=='](object)) {
            return item;
          }
        }
      }

      return nil;
    
    };

    def.$reject = TMP_12 = function() {
      var self = this, $iter = TMP_12._p, block = $iter || nil;

      TMP_12._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reject")
      };
      
      var result = [];

      for (var i = 0, length = self.length, value; i < length; i++) {
        if ((value = block(self[i])) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          result.push(self[i]);
        }
      }
      return result;
    
    };

    def['$reject!'] = TMP_13 = function() {
      var $a, $b, self = this, $iter = TMP_13._p, block = $iter || nil, original = nil;

      TMP_13._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reject!")
      };
      original = self.$length();
      ($a = ($b = self).$delete_if, $a._p = block.$to_proc(), $a).call($b);
      if (self.$length()['$=='](original)) {
        return nil
        } else {
        return self
      };
    };

    def.$replace = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary").$to_a()
      };
      
      self.splice(0, self.length);
      self.push.apply(self, other);
    
      return self;
    };

    def.$reverse = function() {
      var self = this;

      return self.slice(0).reverse();
    };

    def['$reverse!'] = function() {
      var self = this;

      return self.reverse();
    };

    def.$reverse_each = TMP_14 = function() {
      var $a, $b, self = this, $iter = TMP_14._p, block = $iter || nil;

      TMP_14._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reverse_each")
      };
      ($a = ($b = self.$reverse()).$each, $a._p = block.$to_proc(), $a).call($b);
      return self;
    };

    def.$rindex = TMP_15 = function(object) {
      var self = this, $iter = TMP_15._p, block = $iter || nil;

      TMP_15._p = null;
      
      if (object != null) {
        for (var i = self.length - 1; i >= 0; i--) {
          if ((self[i])['$=='](object)) {
            return i;
          }
        }
      }
      else if (block !== nil) {
        for (var i = self.length - 1, value; i >= 0; i--) {
          if ((value = block(self[i])) === $breaker) {
            return $breaker.$v;
          }

          if (value !== false && value !== nil) {
            return i;
          }
        }
      }
      else if (object == null) {
        return self.$enum_for("rindex");
      }

      return nil;
    
    };

    def.$sample = function(n) {
      var $a, $b, TMP_16, self = this;

      if (n == null) {
        n = nil
      }
      if ((($a = ($b = n['$!'](), $b !== false && $b !== nil ?self['$empty?']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return nil};
      if ((($a = (($b = n !== false && n !== nil) ? self['$empty?']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return []};
      if (n !== false && n !== nil) {
        return ($a = ($b = ($range(1, n, false))).$map, $a._p = (TMP_16 = function(){var self = TMP_16._s || this;

        return self['$[]'](self.$rand(self.$length()))}, TMP_16._s = self, TMP_16), $a).call($b)
        } else {
        return self['$[]'](self.$rand(self.$length()))
      };
    };

    def.$select = TMP_17 = function() {
      var self = this, $iter = TMP_17._p, block = $iter || nil;

      TMP_17._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("select")
      };
      
      var result = [];

      for (var i = 0, length = self.length, item, value; i < length; i++) {
        item = self[i];

        if ((value = $opal.$yield1(block, item)) === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          result.push(item);
        }
      }

      return result;
    
    };

    def['$select!'] = TMP_18 = function() {
      var $a, $b, self = this, $iter = TMP_18._p, block = $iter || nil;

      TMP_18._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("select!")
      };
      
      var original = self.length;
      ($a = ($b = self).$keep_if, $a._p = block.$to_proc(), $a).call($b);
      return self.length === original ? nil : self;
    
    };

    def.$shift = function(count) {
      var $a, self = this;

      if ((($a = count === undefined) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
          return nil};
        return self.shift();};
      count = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(count, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      if ((($a = count < 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "negative array size")};
      if ((($a = self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return []};
      return self.splice(0, count);
    };

    $opal.defn(self, '$size', def.$length);

    def.$shuffle = function() {
      var self = this;

      return self.$clone()['$shuffle!']();
    };

    def['$shuffle!'] = function() {
      var self = this;

      
      for (var i = self.length - 1; i > 0; i--) {
        var tmp = self[i],
            j   = Math.floor(Math.random() * (i + 1));

        self[i] = self[j];
        self[j] = tmp;
      }
    
      return self;
    };

    $opal.defn(self, '$slice', def['$[]']);

    def['$slice!'] = function(index, length) {
      var self = this;

      
      if (index < 0) {
        index += self.length;
      }

      if (length != null) {
        return self.splice(index, length);
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      return self.splice(index, 1)[0];
    
    };

    def.$sort = TMP_19 = function() {
      var $a, self = this, $iter = TMP_19._p, block = $iter || nil;

      TMP_19._p = null;
      if ((($a = self.length > 1) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return self
      };
      
      if (!(block !== nil)) {
        block = function(a, b) {
          return (a)['$<=>'](b);
        };
      }

      try {
        return self.slice().sort(function(x, y) {
          var ret = block(x, y);

          if (ret === $breaker) {
            throw $breaker;
          }
          else if (ret === nil) {
            self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + ((x).$inspect()) + " with " + ((y).$inspect()) + " failed");
          }

          return (ret)['$>'](0) ? 1 : ((ret)['$<'](0) ? -1 : 0);
        });
      }
      catch (e) {
        if (e === $breaker) {
          return $breaker.$v;
        }
        else {
          throw e;
        }
      }
    ;
    };

    def['$sort!'] = TMP_20 = function() {
      var $a, $b, self = this, $iter = TMP_20._p, block = $iter || nil;

      TMP_20._p = null;
      
      var result;

      if ((block !== nil)) {
        result = ($a = ($b = (self.slice())).$sort, $a._p = block.$to_proc(), $a).call($b);
      }
      else {
        result = (self.slice()).$sort();
      }

      self.length = 0;
      for(var i = 0, length = result.length; i < length; i++) {
        self.push(result[i]);
      }

      return self;
    ;
    };

    def.$take = function(count) {
      var $a, self = this;

      
      if (count < 0) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a));
      }

      return self.slice(0, count);
    ;
    };

    def.$take_while = TMP_21 = function() {
      var self = this, $iter = TMP_21._p, block = $iter || nil;

      TMP_21._p = null;
      
      var result = [];

      for (var i = 0, length = self.length, item, value; i < length; i++) {
        item = self[i];

        if ((value = block(item)) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          return result;
        }

        result.push(item);
      }

      return result;
    
    };

    def.$to_a = function() {
      var self = this;

      return self;
    };

    $opal.defn(self, '$to_ary', def.$to_a);

    $opal.defn(self, '$to_s', def.$inspect);

    def.$transpose = function() {
      var $a, $b, TMP_22, self = this, result = nil, max = nil;

      if ((($a = self['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
        return []};
      result = [];
      max = nil;
      ($a = ($b = self).$each, $a._p = (TMP_22 = function(row){var self = TMP_22._s || this, $a, $b, TMP_23;
if (row == null) row = nil;
      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](row)) !== nil && (!$a._isBoolean || $a == true))) {
          row = row.$to_a()
          } else {
          row = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(row, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary").$to_a()
        };
        ((($a = max) !== false && $a !== nil) ? $a : max = row.length);
        if ((($a = (row.length)['$=='](max)['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "element size differs (" + (row.length) + " should be " + (max))};
        return ($a = ($b = (row.length)).$times, $a._p = (TMP_23 = function(i){var self = TMP_23._s || this, $a, $b, $c, entry = nil;
if (i == null) i = nil;
        entry = (($a = i, $b = result, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, []))));
          return entry['$<<'](row.$at(i));}, TMP_23._s = self, TMP_23), $a).call($b);}, TMP_22._s = self, TMP_22), $a).call($b);
      return result;
    };

    def.$uniq = function() {
      var self = this;

      
      var result = [],
          seen   = {};

      for (var i = 0, length = self.length, item, hash; i < length; i++) {
        item = self[i];
        hash = item;

        if (!seen[hash]) {
          seen[hash] = true;

          result.push(item);
        }
      }

      return result;
    
    };

    def['$uniq!'] = function() {
      var self = this;

      
      var original = self.length,
          seen     = {};

      for (var i = 0, length = original, item, hash; i < length; i++) {
        item = self[i];
        hash = item;

        if (!seen[hash]) {
          seen[hash] = true;
        }
        else {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      return self.length === original ? nil : self;
    
    };

    def.$unshift = function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      
      for (var i = objects.length - 1; i >= 0; i--) {
        self.unshift(objects[i]);
      }
    
      return self;
    };

    return (def.$zip = TMP_24 = function(others) {
      var self = this, $iter = TMP_24._p, block = $iter || nil;

      others = $slice.call(arguments, 0);
      TMP_24._p = null;
      
      var result = [], size = self.length, part, o;

      for (var i = 0; i < size; i++) {
        part = [self[i]];

        for (var j = 0, jj = others.length; j < jj; j++) {
          o = others[j][i];

          if (o == null) {
            o = nil;
          }

          part[j + 1] = o;
        }

        result[i] = part;
      }

      if (block !== nil) {
        for (var i = 0; i < size; i++) {
          block(result[i]);
        }

        return nil;
      }

      return result;
    
    }, nil) && 'zip';
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/array.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$new', '$allocate', '$initialize', '$to_proc', '$__send__', '$clone', '$respond_to?', '$==', '$eql?', '$inspect', '$*', '$class', '$slice', '$uniq', '$flatten']);
  (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self._proto, $scope = self._scope;

    return ($opal.defs(self, '$inherited', function(klass) {
      var $a, $b, self = this, replace = nil;

      replace = (($a = $scope.Class) == null ? $opal.cm('Class') : $a).$new((($a = ((($b = $scope.Array) == null ? $opal.cm('Array') : $b))._scope).Wrapper == null ? $a.cm('Wrapper') : $a.Wrapper));
      
      klass._proto        = replace._proto;
      klass._proto._klass = klass;
      klass._alloc        = replace._alloc;
      klass.__parent      = (($a = ((($b = $scope.Array) == null ? $opal.cm('Array') : $b))._scope).Wrapper == null ? $a.cm('Wrapper') : $a.Wrapper);

      klass.$allocate = replace.$allocate;
      klass.$new      = replace.$new;
      klass["$[]"]    = replace["$[]"];
    
    }), nil) && 'inherited'
  })(self, null);
  return (function($base, $super) {
    function $Wrapper(){};
    var self = $Wrapper = $klass($base, $super, 'Wrapper', $Wrapper);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5;

    def.literal = nil;
    $opal.defs(self, '$allocate', TMP_1 = function(array) {
      var self = this, $iter = TMP_1._p, $yield = $iter || nil, obj = nil;

      if (array == null) {
        array = []
      }
      TMP_1._p = null;
      obj = $opal.find_super_dispatcher(self, 'allocate', TMP_1, null, $Wrapper).apply(self, []);
      obj.literal = array;
      return obj;
    });

    $opal.defs(self, '$new', TMP_2 = function(args) {
      var $a, $b, self = this, $iter = TMP_2._p, block = $iter || nil, obj = nil;

      args = $slice.call(arguments, 0);
      TMP_2._p = null;
      obj = self.$allocate();
      ($a = ($b = obj).$initialize, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
      return obj;
    });

    $opal.defs(self, '$[]', function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      return self.$allocate(objects);
    });

    def.$initialize = TMP_3 = function(args) {
      var $a, $b, $c, self = this, $iter = TMP_3._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_3._p = null;
      return self.literal = ($a = ($b = (($c = $scope.Array) == null ? $opal.cm('Array') : $c)).$new, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
    };

    def.$method_missing = TMP_4 = function(args) {
      var $a, $b, self = this, $iter = TMP_4._p, block = $iter || nil, result = nil;

      args = $slice.call(arguments, 0);
      TMP_4._p = null;
      result = ($a = ($b = self.literal).$__send__, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
      if ((($a = result === self.literal) !== nil && (!$a._isBoolean || $a == true))) {
        return self
        } else {
        return result
      };
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return self.literal = (other.literal).$clone();
    };

    def['$respond_to?'] = TMP_5 = function(name) {var $zuper = $slice.call(arguments, 0);
      var $a, self = this, $iter = TMP_5._p, $yield = $iter || nil;

      TMP_5._p = null;
      return ((($a = $opal.find_super_dispatcher(self, 'respond_to?', TMP_5, $iter).apply(self, $zuper)) !== false && $a !== nil) ? $a : self.literal['$respond_to?'](name));
    };

    def['$=='] = function(other) {
      var self = this;

      return self.literal['$=='](other);
    };

    def['$eql?'] = function(other) {
      var self = this;

      return self.literal['$eql?'](other);
    };

    def.$to_a = function() {
      var self = this;

      return self.literal;
    };

    def.$to_ary = function() {
      var self = this;

      return self;
    };

    def.$inspect = function() {
      var self = this;

      return self.literal.$inspect();
    };

    def['$*'] = function(other) {
      var self = this;

      
      var result = self.literal['$*'](other);

      if (result._isArray) {
        return self.$class().$allocate(result)
      }
      else {
        return result;
      }
    ;
    };

    def['$[]'] = function(index, length) {
      var self = this;

      
      var result = self.literal.$slice(index, length);

      if (result._isArray && (index._isRange || length !== undefined)) {
        return self.$class().$allocate(result)
      }
      else {
        return result;
      }
    ;
    };

    $opal.defn(self, '$slice', def['$[]']);

    def.$uniq = function() {
      var self = this;

      return self.$class().$allocate(self.literal.$uniq());
    };

    return (def.$flatten = function(level) {
      var self = this;

      return self.$class().$allocate(self.literal.$flatten(level));
    }, nil) && 'flatten';
  })((($a = $scope.Array) == null ? $opal.cm('Array') : $a), null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/array/inheritance.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$!', '$==', '$call', '$coerce_to!', '$lambda?', '$abs', '$arity', '$raise', '$enum_for', '$flatten', '$inspect', '$===', '$alias_method', '$clone']);
  ;
  return (function($base, $super) {
    function $Hash(){};
    var self = $Hash = $klass($base, $super, 'Hash', $Hash);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13;

    def.proc = def.none = nil;
    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    $opal.defs(self, '$[]', function(objs) {
      var self = this;

      objs = $slice.call(arguments, 0);
      return $opal.hash.apply(null, objs);
    });

    $opal.defs(self, '$allocate', function() {
      var self = this;

      
      var hash = new self._alloc;

      hash.map  = {};
      hash.keys = [];
      hash.none = nil;
      hash.proc = nil;

      return hash;
    
    });

    def.$initialize = TMP_1 = function(defaults) {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      
      self.none = (defaults === undefined ? nil : defaults);
      self.proc = block;
    
      return self;
    };

    def['$=='] = function(other) {
      var self = this;

      
      if (self === other) {
        return true;
      }

      if (!other.map || !other.keys) {
        return false;
      }

      if (self.keys.length !== other.keys.length) {
        return false;
      }

      var map  = self.map,
          map2 = other.map;

      for (var i = 0, length = self.keys.length; i < length; i++) {
        var key = self.keys[i], obj = map[key], obj2 = map2[key];
        if (obj2 === undefined || (obj)['$=='](obj2)['$!']()) {
          return false;
        }
      }

      return true;
    
    };

    def['$[]'] = function(key) {
      var self = this;

      
      var map = self.map;

      if ($opal.hasOwnProperty.call(map, key)) {
        return map[key];
      }

      var proc = self.proc;

      if (proc !== nil) {
        return (proc).$call(self, key);
      }

      return self.none;
    
    };

    def['$[]='] = function(key, value) {
      var self = this;

      
      var map = self.map;

      if (!$opal.hasOwnProperty.call(map, key)) {
        self.keys.push(key);
      }

      map[key] = value;

      return value;
    
    };

    def.$assoc = function(object) {
      var self = this;

      
      var keys = self.keys, key;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if ((key)['$=='](object)) {
          return [key, self.map[key]];
        }
      }

      return nil;
    
    };

    def.$clear = function() {
      var self = this;

      
      self.map = {};
      self.keys = [];
      return self;
    
    };

    def.$clone = function() {
      var self = this;

      
      var map  = {},
          keys = [];

      for (var i = 0, length = self.keys.length; i < length; i++) {
        var key   = self.keys[i],
            value = self.map[key];

        keys.push(key);
        map[key] = value;
      }

      var hash = new self._klass._alloc();

      hash.map  = map;
      hash.keys = keys;
      hash.none = self.none;
      hash.proc = self.proc;

      return hash;
    
    };

    def.$default = function(val) {
      var self = this;

      
      if (val !== undefined && self.proc !== nil) {
        return self.proc.$call(self, val);
      }
      return self.none;
    ;
    };

    def['$default='] = function(object) {
      var self = this;

      
      self.proc = nil;
      return (self.none = object);
    
    };

    def.$default_proc = function() {
      var self = this;

      return self.proc;
    };

    def['$default_proc='] = function(proc) {
      var $a, self = this;

      
      if (proc !== nil) {
        proc = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](proc, (($a = $scope.Proc) == null ? $opal.cm('Proc') : $a), "to_proc");

        if (proc['$lambda?']() && proc.$arity().$abs() != 2) {
          self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "default_proc takes two arguments");
        }
      }
      self.none = nil;
      return (self.proc = proc);
    ;
    };

    def.$delete = TMP_2 = function(key) {
      var self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      
      var map  = self.map, result = map[key];

      if (result != null) {
        delete map[key];
        self.keys.$delete(key);

        return result;
      }

      if (block !== nil) {
        return block.$call(key);
      }
      return nil;
    
    };

    def.$delete_if = TMP_3 = function() {
      var self = this, $iter = TMP_3._p, block = $iter || nil;

      TMP_3._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("delete_if")
      };
      
      var map = self.map, keys = self.keys, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key];

        if ((value = block(key, obj)) === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          keys.splice(i, 1);
          delete map[key];

          length--;
          i--;
        }
      }

      return self;
    
    };

    $opal.defn(self, '$dup', def.$clone);

    def.$each = TMP_4 = function() {
      var self = this, $iter = TMP_4._p, block = $iter || nil;

      TMP_4._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each")
      };
      
      var map  = self.map,
          keys = self.keys;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key   = keys[i],
            value = $opal.$yield1(block, [key, map[key]]);

        if (value === $breaker) {
          return $breaker.$v;
        }
      }

      return self;
    
    };

    def.$each_key = TMP_5 = function() {
      var self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each_key")
      };
      
      var keys = self.keys;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i];

        if (block(key) === $breaker) {
          return $breaker.$v;
        }
      }

      return self;
    
    };

    $opal.defn(self, '$each_pair', def.$each);

    def.$each_value = TMP_6 = function() {
      var self = this, $iter = TMP_6._p, block = $iter || nil;

      TMP_6._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each_value")
      };
      
      var map = self.map, keys = self.keys;

      for (var i = 0, length = keys.length; i < length; i++) {
        if (block(map[keys[i]]) === $breaker) {
          return $breaker.$v;
        }
      }

      return self;
    
    };

    def['$empty?'] = function() {
      var self = this;

      return self.keys.length === 0;
    };

    $opal.defn(self, '$eql?', def['$==']);

    def.$fetch = TMP_7 = function(key, defaults) {
      var $a, self = this, $iter = TMP_7._p, block = $iter || nil;

      TMP_7._p = null;
      
      var value = self.map[key];

      if (value != null) {
        return value;
      }

      if (block !== nil) {
        var value;

        if ((value = block(key)) === $breaker) {
          return $breaker.$v;
        }

        return value;
      }

      if (defaults != null) {
        return defaults;
      }

      self.$raise((($a = $scope.KeyError) == null ? $opal.cm('KeyError') : $a), "key not found");
    
    };

    def.$flatten = function(level) {
      var self = this;

      
      var map = self.map, keys = self.keys, result = [];

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], value = map[key];

        result.push(key);

        if (value._isArray) {
          if (level == null || level === 1) {
            result.push(value);
          }
          else {
            result = result.concat((value).$flatten(level - 1));
          }
        }
        else {
          result.push(value);
        }
      }

      return result;
    
    };

    def['$has_key?'] = function(key) {
      var self = this;

      return $opal.hasOwnProperty.call(self.map, key);
    };

    def['$has_value?'] = function(value) {
      var self = this;

      
      for (var assoc in self.map) {
        if ((self.map[assoc])['$=='](value)) {
          return true;
        }
      }

      return false;
    ;
    };

    def.$hash = function() {
      var self = this;

      return self._id;
    };

    $opal.defn(self, '$include?', def['$has_key?']);

    def.$index = function(object) {
      var self = this;

      
      var map = self.map, keys = self.keys;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i];

        if ((map[key])['$=='](object)) {
          return key;
        }
      }

      return nil;
    
    };

    def.$indexes = function(keys) {
      var self = this;

      keys = $slice.call(arguments, 0);
      
      var result = [], map = self.map, val;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], val = map[key];

        if (val != null) {
          result.push(val);
        }
        else {
          result.push(self.none);
        }
      }

      return result;
    
    };

    $opal.defn(self, '$indices', def.$indexes);

    def.$inspect = function() {
      var self = this;

      
      var inspect = [], keys = self.keys, map = self.map;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], val = map[key];

        if (val === self) {
          inspect.push((key).$inspect() + '=>' + '{...}');
        } else {
          inspect.push((key).$inspect() + '=>' + (map[key]).$inspect());
        }
      }

      return '{' + inspect.join(', ') + '}';
    ;
    };

    def.$invert = function() {
      var self = this;

      
      var result = $opal.hash(), keys = self.keys, map = self.map,
          keys2 = result.keys, map2 = result.map;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key];

        keys2.push(obj);
        map2[obj] = key;
      }

      return result;
    
    };

    def.$keep_if = TMP_8 = function() {
      var self = this, $iter = TMP_8._p, block = $iter || nil;

      TMP_8._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("keep_if")
      };
      
      var map = self.map, keys = self.keys, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key];

        if ((value = block(key, obj)) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          keys.splice(i, 1);
          delete map[key];

          length--;
          i--;
        }
      }

      return self;
    
    };

    $opal.defn(self, '$key', def.$index);

    $opal.defn(self, '$key?', def['$has_key?']);

    def.$keys = function() {
      var self = this;

      return self.keys.slice(0);
    };

    def.$length = function() {
      var self = this;

      return self.keys.length;
    };

    $opal.defn(self, '$member?', def['$has_key?']);

    def.$merge = TMP_9 = function(other) {
      var $a, self = this, $iter = TMP_9._p, block = $iter || nil;

      TMP_9._p = null;
      
      if (! (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a)['$==='](other)) {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](other, (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a), "to_hash");
      }

      var keys = self.keys, map = self.map,
          result = $opal.hash(), keys2 = result.keys, map2 = result.map;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i];

        keys2.push(key);
        map2[key] = map[key];
      }

      var keys = other.keys, map = other.map;

      if (block === nil) {
        for (var i = 0, length = keys.length; i < length; i++) {
          var key = keys[i];

          if (map2[key] == null) {
            keys2.push(key);
          }

          map2[key] = map[key];
        }
      }
      else {
        for (var i = 0, length = keys.length; i < length; i++) {
          var key = keys[i];

          if (map2[key] == null) {
            keys2.push(key);
            map2[key] = map[key];
          }
          else {
            map2[key] = block(key, map2[key], map[key]);
          }
        }
      }

      return result;
    ;
    };

    def['$merge!'] = TMP_10 = function(other) {
      var $a, self = this, $iter = TMP_10._p, block = $iter || nil;

      TMP_10._p = null;
      
      if (! (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a)['$==='](other)) {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](other, (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a), "to_hash");
      }

      var keys = self.keys, map = self.map,
          keys2 = other.keys, map2 = other.map;

      if (block === nil) {
        for (var i = 0, length = keys2.length; i < length; i++) {
          var key = keys2[i];

          if (map[key] == null) {
            keys.push(key);
          }

          map[key] = map2[key];
        }
      }
      else {
        for (var i = 0, length = keys2.length; i < length; i++) {
          var key = keys2[i];

          if (map[key] == null) {
            keys.push(key);
            map[key] = map2[key];
          }
          else {
            map[key] = block(key, map[key], map2[key]);
          }
        }
      }

      return self;
    ;
    };

    def.$rassoc = function(object) {
      var self = this;

      
      var keys = self.keys, map = self.map;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key];

        if ((obj)['$=='](object)) {
          return [key, obj];
        }
      }

      return nil;
    
    };

    def.$reject = TMP_11 = function() {
      var self = this, $iter = TMP_11._p, block = $iter || nil;

      TMP_11._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("reject")
      };
      
      var keys = self.keys, map = self.map,
          result = $opal.hash(), map2 = result.map, keys2 = result.keys;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key], value;

        if ((value = block(key, obj)) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          keys2.push(key);
          map2[key] = obj;
        }
      }

      return result;
    
    };

    def.$replace = function(other) {
      var self = this;

      
      var map = self.map = {}, keys = self.keys = [];

      for (var i = 0, length = other.keys.length; i < length; i++) {
        var key = other.keys[i];
        keys.push(key);
        map[key] = other.map[key];
      }

      return self;
    
    };

    def.$select = TMP_12 = function() {
      var self = this, $iter = TMP_12._p, block = $iter || nil;

      TMP_12._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("select")
      };
      
      var keys = self.keys, map = self.map,
          result = $opal.hash(), map2 = result.map, keys2 = result.keys;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key], value;

        if ((value = block(key, obj)) === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          keys2.push(key);
          map2[key] = obj;
        }
      }

      return result;
    
    };

    def['$select!'] = TMP_13 = function() {
      var self = this, $iter = TMP_13._p, block = $iter || nil;

      TMP_13._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("select!")
      };
      
      var map = self.map, keys = self.keys, value, result = nil;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key];

        if ((value = block(key, obj)) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          keys.splice(i, 1);
          delete map[key];

          length--;
          i--;
          result = self
        }
      }

      return result;
    
    };

    def.$shift = function() {
      var self = this;

      
      var keys = self.keys, map = self.map;

      if (keys.length) {
        var key = keys[0], obj = map[key];

        delete map[key];
        keys.splice(0, 1);

        return [key, obj];
      }

      return nil;
    
    };

    $opal.defn(self, '$size', def.$length);

    self.$alias_method("store", "[]=");

    def.$to_a = function() {
      var self = this;

      
      var keys = self.keys, map = self.map, result = [];

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i];
        result.push([key, map[key]]);
      }

      return result;
    
    };

    def.$to_h = function() {
      var self = this;

      
      var hash   = new Opal.Hash._alloc,
          cloned = self.$clone();

      hash.map  = cloned.map;
      hash.keys = cloned.keys;
      hash.none = cloned.none;
      hash.proc = cloned.proc;

      return hash;
    ;
    };

    def.$to_hash = function() {
      var self = this;

      return self;
    };

    $opal.defn(self, '$to_s', def.$inspect);

    $opal.defn(self, '$update', def['$merge!']);

    $opal.defn(self, '$value?', def['$has_value?']);

    $opal.defn(self, '$values_at', def.$indexes);

    return (def.$values = function() {
      var self = this;

      
      var map    = self.map,
          result = [];

      for (var key in map) {
        result.push(map[key]);
      }

      return result;
    
    }, nil) && 'values';
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/hash.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$include', '$to_str', '$===', '$format', '$coerce_to', '$to_s', '$respond_to?', '$<=>', '$raise', '$=~', '$empty?', '$ljust', '$ceil', '$/', '$+', '$rjust', '$floor', '$to_a', '$each_char', '$to_proc', '$coerce_to!', '$initialize_clone', '$initialize_dup', '$enum_for', '$split', '$chomp', '$escape', '$class', '$to_i', '$name', '$!', '$each_line', '$match', '$new', '$try_convert', '$chars', '$&', '$join', '$is_a?', '$[]', '$str', '$value', '$proc', '$send']);
  ;
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7;

    def.length = nil;
    self.$include((($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a));

    def._isString = true;

    $opal.defs(self, '$try_convert', function(what) {
      var self = this;

      try {
      return what.$to_str()
      } catch ($err) {if (true) {
        return nil
        }else { throw $err; }
      };
    });

    $opal.defs(self, '$new', function(str) {
      var self = this;

      if (str == null) {
        str = ""
      }
      return new String(str);
    });

    def['$%'] = function(data) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](data)) !== nil && (!$a._isBoolean || $a == true))) {
        return ($a = self).$format.apply($a, [self].concat(data))
        } else {
        return self.$format(self, data)
      };
    };

    def['$*'] = function(count) {
      var self = this;

      
      if (count < 1) {
        return '';
      }

      var result  = '',
          pattern = self;

      while (count > 0) {
        if (count & 1) {
          result += pattern;
        }

        count >>= 1;
        pattern += pattern;
      }

      return result;
    
    };

    def['$+'] = function(other) {
      var $a, self = this;

      other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str");
      return self + other.$to_s();
    };

    def['$<=>'] = function(other) {
      var $a, self = this;

      if ((($a = other['$respond_to?']("to_str")) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_str().$to_s();
        return self > other ? 1 : (self < other ? -1 : 0);
        } else {
        
        var cmp = other['$<=>'](self);

        if (cmp === nil) {
          return nil;
        }
        else {
          return cmp > 0 ? -1 : (cmp < 0 ? 1 : 0);
        }
      ;
      };
    };

    def['$=='] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.String) == null ? $opal.cm('String') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      return self.$to_s() == other.$to_s();
    };

    $opal.defn(self, '$eql?', def['$==']);

    $opal.defn(self, '$===', def['$==']);

    def['$=~'] = function(other) {
      var $a, self = this;

      
      if (other._isString) {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "type mismatch: String given");
      }

      return other['$=~'](self);
    ;
    };

    def['$[]'] = function(index, length) {
      var self = this;

      
      var size = self.length;

      if (index._isRange) {
        var exclude = index.exclude,
            length  = index.end,
            index   = index.begin;

        if (index < 0) {
          index += size;
        }

        if (length < 0) {
          length += size;
        }

        if (!exclude) {
          length += 1;
        }

        if (index > size) {
          return nil;
        }

        length = length - index;

        if (length < 0) {
          length = 0;
        }

        return self.substr(index, length);
      }

      if (index < 0) {
        index += self.length;
      }

      if (length == null) {
        if (index >= self.length || index < 0) {
          return nil;
        }

        return self.substr(index, 1);
      }

      if (index > self.length || index < 0) {
        return nil;
      }

      return self.substr(index, length);
    
    };

    def.$capitalize = function() {
      var self = this;

      return self.charAt(0).toUpperCase() + self.substr(1).toLowerCase();
    };

    def.$casecmp = function(other) {
      var $a, self = this;

      other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
      return (self.toLowerCase())['$<=>'](other.toLowerCase());
    };

    def.$center = function(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " "
      }
      width = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(width, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      padstr = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(padstr, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "zero width padding")};
      if ((($a = width <= self.length) !== nil && (!$a._isBoolean || $a == true))) {
        return self};
      
      var ljustified = self.$ljust((width['$+'](self.length))['$/'](2).$ceil(), padstr),
          rjustified = self.$rjust((width['$+'](self.length))['$/'](2).$floor(), padstr);

      return rjustified + ljustified.slice(self.length);
    ;
    };

    def.$chars = TMP_1 = function() {
      var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$each_char().$to_a()
      };
      return ($a = ($b = self).$each_char, $a._p = block.$to_proc(), $a).call($b);
    };

    def.$chomp = function(separator) {
      var $a, self = this;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      if ((($a = separator === nil || self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return self};
      separator = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](separator, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
      
      if (separator === "\n") {
        return self.replace(/\r?\n?$/, '');
      }
      else if (separator === "") {
        return self.replace(/(\r?\n)+$/, '');
      }
      else if (self.length > separator.length) {
        var tail = self.substr(self.length - separator.length, separator.length);

        if (tail === separator) {
          return self.substr(0, self.length - separator.length);
        }
      }
    
      return self;
    };

    def.$chop = function() {
      var self = this;

      
      var length = self.length;

      if (length <= 1) {
        return "";
      }

      if (self.charAt(length - 1) === "\n" && self.charAt(length - 2) === "\r") {
        return self.substr(0, length - 2);
      }
      else {
        return self.substr(0, length - 1);
      }
    
    };

    def.$chr = function() {
      var self = this;

      return self.charAt(0);
    };

    def.$clone = function() {
      var self = this, copy = nil;

      copy = self.slice();
      copy.$initialize_clone(self);
      return copy;
    };

    def.$dup = function() {
      var self = this, copy = nil;

      copy = self.slice();
      copy.$initialize_dup(self);
      return copy;
    };

    def.$count = function(str) {
      var self = this;

      return (self.length - self.replace(new RegExp(str, 'g'), '').length) / str.length;
    };

    $opal.defn(self, '$dup', def.$clone);

    def.$downcase = function() {
      var self = this;

      return self.toLowerCase();
    };

    def.$each_char = TMP_2 = function() {
      var $a, self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_char")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        ((($a = $opal.$yield1(block, self.charAt(i))) === $breaker) ? $breaker.$v : $a);
      }
    
      return self;
    };

    def.$each_line = TMP_3 = function(separator) {
      var $a, self = this, $iter = TMP_3._p, $yield = $iter || nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      TMP_3._p = null;
      if (($yield !== nil)) {
        } else {
        return self.$split(separator)
      };
      
      var chomped  = self.$chomp(),
          trailing = self.length != chomped.length,
          splitted = chomped.split(separator);

      for (var i = 0, length = splitted.length; i < length; i++) {
        if (i < length - 1 || trailing) {
          ((($a = $opal.$yield1($yield, splitted[i] + separator)) === $breaker) ? $breaker.$v : $a);
        }
        else {
          ((($a = $opal.$yield1($yield, splitted[i])) === $breaker) ? $breaker.$v : $a);
        }
      }
    ;
      return self;
    };

    def['$empty?'] = function() {
      var self = this;

      return self.length === 0;
    };

    def['$end_with?'] = function(suffixes) {
      var $a, self = this;

      suffixes = $slice.call(arguments, 0);
      
      for (var i = 0, length = suffixes.length; i < length; i++) {
        var suffix = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(suffixes[i], (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();

        if (self.length >= suffix.length &&
            self.substr(self.length - suffix.length, suffix.length) == suffix) {
          return true;
        }
      }
    
      return false;
    };

    $opal.defn(self, '$eql?', def['$==']);

    $opal.defn(self, '$equal?', def['$===']);

    def.$gsub = TMP_4 = function(pattern, replace) {
      var $a, $b, $c, self = this, $iter = TMP_4._p, block = $iter || nil;

      TMP_4._p = null;
      if ((($a = ((($b = (($c = $scope.String) == null ? $opal.cm('String') : $c)['$==='](pattern)) !== false && $b !== nil) ? $b : pattern['$respond_to?']("to_str"))) !== nil && (!$a._isBoolean || $a == true))) {
        pattern = (new RegExp("" + (($a = $scope.Regexp) == null ? $opal.cm('Regexp') : $a).$escape(pattern.$to_str())))};
      if ((($a = (($b = $scope.Regexp) == null ? $opal.cm('Regexp') : $b)['$==='](pattern)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "wrong argument type " + (pattern.$class()) + " (expected Regexp)")
      };
      
      var pattern = pattern.toString(),
          options = pattern.substr(pattern.lastIndexOf('/') + 1) + 'g',
          regexp  = pattern.substr(1, pattern.lastIndexOf('/') - 1);

      self.$sub._p = block;
      return self.$sub(new RegExp(regexp, options), replace);
    
    };

    def.$hash = function() {
      var self = this;

      return self.toString();
    };

    def.$hex = function() {
      var self = this;

      return self.$to_i(16);
    };

    def['$include?'] = function(other) {
      var $a, self = this;

      
      if (other._isString) {
        return self.indexOf(other) !== -1;
      }
    
      if ((($a = other['$respond_to?']("to_str")) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "no implicit conversion of " + (other.$class().$name()) + " into String")
      };
      return self.indexOf(other.$to_str()) !== -1;
    };

    def.$index = function(what, offset) {
      var $a, $b, self = this, result = nil;

      if (offset == null) {
        offset = nil
      }
      if ((($a = (($b = $scope.String) == null ? $opal.cm('String') : $b)['$==='](what)) !== nil && (!$a._isBoolean || $a == true))) {
        what = what.$to_s()
      } else if ((($a = what['$respond_to?']("to_str")) !== nil && (!$a._isBoolean || $a == true))) {
        what = what.$to_str().$to_s()
      } else if ((($a = (($b = $scope.Regexp) == null ? $opal.cm('Regexp') : $b)['$==='](what)['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "type mismatch: " + (what.$class()) + " given")};
      result = -1;
      if (offset !== false && offset !== nil) {
        offset = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(offset, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        
        var size = self.length;

        if (offset < 0) {
          offset = offset + size;
        }

        if (offset > size) {
          return nil;
        }
      
        if ((($a = (($b = $scope.Regexp) == null ? $opal.cm('Regexp') : $b)['$==='](what)) !== nil && (!$a._isBoolean || $a == true))) {
          result = ((($a = (what['$=~'](self.substr(offset)))) !== false && $a !== nil) ? $a : -1)
          } else {
          result = self.substr(offset).indexOf(what)
        };
        
        if (result !== -1) {
          result += offset;
        }
      
      } else if ((($a = (($b = $scope.Regexp) == null ? $opal.cm('Regexp') : $b)['$==='](what)) !== nil && (!$a._isBoolean || $a == true))) {
        result = ((($a = (what['$=~'](self))) !== false && $a !== nil) ? $a : -1)
        } else {
        result = self.indexOf(what)
      };
      if ((($a = result === -1) !== nil && (!$a._isBoolean || $a == true))) {
        return nil
        } else {
        return result
      };
    };

    def.$inspect = function() {
      var self = this;

      
      var escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
          meta      = {
            '\b': '\\b',
            '\t': '\\t',
            '\n': '\\n',
            '\f': '\\f',
            '\r': '\\r',
            '"' : '\\"',
            '\\': '\\\\'
          };

      escapable.lastIndex = 0;

      return escapable.test(self) ? '"' + self.replace(escapable, function(a) {
        var c = meta[a];

        return typeof c === 'string' ? c :
          '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
      }) + '"' : '"' + self + '"';
    
    };

    def.$intern = function() {
      var self = this;

      return self;
    };

    def.$lines = function(separator) {
      var self = this;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      return self.$each_line(separator).$to_a();
    };

    def.$length = function() {
      var self = this;

      return self.length;
    };

    def.$ljust = function(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " "
      }
      width = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(width, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      padstr = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(padstr, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "zero width padding")};
      if ((($a = width <= self.length) !== nil && (!$a._isBoolean || $a == true))) {
        return self};
      
      var index  = -1,
          result = "";

      width -= self.length;

      while (++index < width) {
        result += padstr;
      }

      return self + result.slice(0, width);
    
    };

    def.$lstrip = function() {
      var self = this;

      return self.replace(/^\s*/, '');
    };

    def.$match = TMP_5 = function(pattern, pos) {
      var $a, $b, $c, self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      if ((($a = ((($b = (($c = $scope.String) == null ? $opal.cm('String') : $c)['$==='](pattern)) !== false && $b !== nil) ? $b : pattern['$respond_to?']("to_str"))) !== nil && (!$a._isBoolean || $a == true))) {
        pattern = (new RegExp("" + (($a = $scope.Regexp) == null ? $opal.cm('Regexp') : $a).$escape(pattern.$to_str())))};
      if ((($a = (($b = $scope.Regexp) == null ? $opal.cm('Regexp') : $b)['$==='](pattern)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "wrong argument type " + (pattern.$class()) + " (expected Regexp)")
      };
      return ($a = ($b = pattern).$match, $a._p = block.$to_proc(), $a).call($b, self, pos);
    };

    def.$next = function() {
      var self = this;

      
      if (self.length === 0) {
        return "";
      }

      var initial = self.substr(0, self.length - 1);
      var last    = String.fromCharCode(self.charCodeAt(self.length - 1) + 1);

      return initial + last;
    
    };

    def.$ord = function() {
      var self = this;

      return self.charCodeAt(0);
    };

    def.$partition = function(str) {
      var self = this;

      
      var result = self.split(str);
      var splitter = (result[0].length === self.length ? "" : str);

      return [result[0], splitter, result.slice(1).join(str.toString())];
    
    };

    def.$reverse = function() {
      var self = this;

      return self.split('').reverse().join('');
    };

    def.$rindex = function(search, offset) {
      var $a, self = this;

      
      var search_type = (search == null ? Opal.NilClass : search.constructor);
      if (search_type != String && search_type != RegExp) {
        var msg = "type mismatch: " + search_type + " given";
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a).$new(msg));
      }

      if (self.length == 0) {
        return search.length == 0 ? 0 : nil;
      }

      var result = -1;
      if (offset != null) {
        if (offset < 0) {
          offset = self.length + offset;
        }

        if (search_type == String) {
          result = self.lastIndexOf(search, offset);
        }
        else {
          result = self.substr(0, offset + 1).$reverse().search(search);
          if (result !== -1) {
            result = offset - result;
          }
        }
      }
      else {
        if (search_type == String) {
          result = self.lastIndexOf(search);
        }
        else {
          result = self.$reverse().search(search);
          if (result !== -1) {
            result = self.length - 1 - result;
          }
        }
      }

      return result === -1 ? nil : result;
    
    };

    def.$rjust = function(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " "
      }
      width = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(width, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      padstr = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(padstr, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "zero width padding")};
      if ((($a = width <= self.length) !== nil && (!$a._isBoolean || $a == true))) {
        return self};
      
      var chars     = Math.floor(width - self.length),
          patterns  = Math.floor(chars / padstr.length),
          result    = Array(patterns + 1).join(padstr),
          remaining = chars - result.length;

      return result + padstr.slice(0, remaining) + self;
    
    };

    def.$rstrip = function() {
      var self = this;

      return self.replace(/\s*$/, '');
    };

    def.$scan = TMP_6 = function(pattern) {
      var $a, self = this, $iter = TMP_6._p, block = $iter || nil;

      TMP_6._p = null;
      
      if (pattern.global) {
        // should we clear it afterwards too?
        pattern.lastIndex = 0;
      }
      else {
        // rewrite regular expression to add the global flag to capture pre/post match
        pattern = new RegExp(pattern.source, 'g' + (pattern.multiline ? 'm' : '') + (pattern.ignoreCase ? 'i' : ''));
      }

      var result = [];
      var match;

      while ((match = pattern.exec(self)) != null) {
        var match_data = (($a = $scope.MatchData) == null ? $opal.cm('MatchData') : $a).$new(pattern, match);
        if (block === nil) {
          match.length == 1 ? result.push(match[0]) : result.push(match.slice(1));
        }
        else {
          match.length == 1 ? block(match[0]) : block.apply(self, match.slice(1));
        }
      }

      return (block !== nil ? self : result);
    
    };

    $opal.defn(self, '$size', def.$length);

    $opal.defn(self, '$slice', def['$[]']);

    def.$split = function(pattern, limit) {
      var $a, self = this;
      if ($gvars[";"] == null) $gvars[";"] = nil;

      if (pattern == null) {
        pattern = ((($a = $gvars[";"]) !== false && $a !== nil) ? $a : " ")
      }
      
      if (pattern === nil || pattern === undefined) {
        pattern = $gvars[";"];
      }

      var result = [];
      if (limit !== undefined) {
        limit = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](limit, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      }

      if (self.length === 0) {
        return [];
      }

      if (limit === 1) {
        return [self];
      }

      if (pattern && pattern._isRegexp) {
        var pattern_str = pattern.toString();

        /* Opal and JS's repr of an empty RE. */
        var blank_pattern = (pattern_str.substr(0, 3) == '/^/') ||
                  (pattern_str.substr(0, 6) == '/(?:)/');

        /* This is our fast path */
        if (limit === undefined || limit === 0) {
          result = self.split(blank_pattern ? /(?:)/ : pattern);
        }
        else {
          /* RegExp.exec only has sane behavior with global flag */
          if (! pattern.global) {
            pattern = eval(pattern_str + 'g');
          }

          var match_data;
          var prev_index = 0;
          pattern.lastIndex = 0;

          while ((match_data = pattern.exec(self)) !== null) {
            var segment = self.slice(prev_index, match_data.index);
            result.push(segment);

            prev_index = pattern.lastIndex;

            if (match_data[0].length === 0) {
              if (blank_pattern) {
                /* explicitly split on JS's empty RE form.*/
                pattern = /(?:)/;
              }

              result = self.split(pattern);
              /* with "unlimited", ruby leaves a trail on blanks. */
              if (limit !== undefined && limit < 0 && blank_pattern) {
                result.push('');
              }

              prev_index = undefined;
              break;
            }

            if (limit !== undefined && limit > 1 && result.length + 1 == limit) {
              break;
            }
          }

          if (prev_index !== undefined) {
            result.push(self.slice(prev_index, self.length));
          }
        }
      }
      else {
        var splitted = 0, start = 0, lim = 0;

        if (pattern === nil || pattern === undefined) {
          pattern = ' '
        } else {
          pattern = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$try_convert(pattern, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
        }

        var string = (pattern == ' ') ? self.replace(/[\r\n\t\v]\s+/g, ' ')
                                      : self;
        var cursor = -1;
        while ((cursor = string.indexOf(pattern, start)) > -1 && cursor < string.length) {
          if (splitted + 1 === limit) {
            break;
          }

          if (pattern == ' ' && cursor == start) {
            start = cursor + 1;
            continue;
          }

          result.push(string.substr(start, pattern.length ? cursor - start : 1));
          splitted++;

          start = cursor + (pattern.length ? pattern.length : 1);
        }

        if (string.length > 0 && (limit < 0 || string.length > start)) {
          if (string.length == start) {
            result.push('');
          }
          else {
            result.push(string.substr(start, string.length));
          }
        }
      }

      if (limit === undefined || limit === 0) {
        while (result[result.length-1] === '') {
          result.length = result.length - 1;
        }
      }

      if (limit > 0) {
        var tail = result.slice(limit - 1).join('');
        result.splice(limit - 1, result.length - 1, tail);
      }

      return result;
    ;
    };

    def.$squeeze = function(sets) {
      var $a, self = this;

      sets = $slice.call(arguments, 0);
      
      if (sets.length === 0) {
        return self.replace(/(.)\1+/g, '$1');
      }
    
      
      var set = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(sets[0], (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$chars();

      for (var i = 1, length = sets.length; i < length; i++) {
        set = (set)['$&']((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(sets[i], (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$chars());
      }

      if (set.length === 0) {
        return self;
      }

      return self.replace(new RegExp("([" + (($a = $scope.Regexp) == null ? $opal.cm('Regexp') : $a).$escape((set).$join()) + "])\\1+", "g"), "$1");
    ;
    };

    def['$start_with?'] = function(prefixes) {
      var $a, self = this;

      prefixes = $slice.call(arguments, 0);
      
      for (var i = 0, length = prefixes.length; i < length; i++) {
        var prefix = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(prefixes[i], (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();

        if (self.indexOf(prefix) === 0) {
          return true;
        }
      }

      return false;
    
    };

    def.$strip = function() {
      var self = this;

      return self.replace(/^\s*/, '').replace(/\s*$/, '');
    };

    def.$sub = TMP_7 = function(pattern, replace) {
      var $a, self = this, $iter = TMP_7._p, block = $iter || nil;

      TMP_7._p = null;
      
      if (typeof(replace) === 'string') {
        // convert Ruby back reference to JavaScript back reference
        replace = replace.replace(/\\([1-9])/g, '$$$1')
        return self.replace(pattern, replace);
      }
      if (block !== nil) {
        return self.replace(pattern, function() {
          // FIXME: this should be a formal MatchData object with all the goodies
          var match_data = []
          for (var i = 0, len = arguments.length; i < len; i++) {
            var arg = arguments[i];
            if (arg == undefined) {
              match_data.push(nil);
            }
            else {
              match_data.push(arg);
            }
          }

          var str = match_data.pop();
          var offset = match_data.pop();
          var match_len = match_data.length;

          // $1, $2, $3 not being parsed correctly in Ruby code
          //for (var i = 1; i < match_len; i++) {
          //  __gvars[String(i)] = match_data[i];
          //}
          $gvars["&"] = match_data[0];
          $gvars["~"] = match_data;
          return block(match_data[0]);
        });
      }
      else if (replace !== undefined) {
        if (replace['$is_a?']((($a = $scope.Hash) == null ? $opal.cm('Hash') : $a))) {
          return self.replace(pattern, function(str) {
            var value = replace['$[]'](self.$str());

            return (value == null) ? nil : self.$value().$to_s();
          });
        }
        else {
          replace = (($a = $scope.String) == null ? $opal.cm('String') : $a).$try_convert(replace);

          if (replace == null) {
            self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "can't convert " + (replace.$class()) + " into String");
          }

          return self.replace(pattern, replace);
        }
      }
      else {
        // convert Ruby back reference to JavaScript back reference
        replace = replace.toString().replace(/\\([1-9])/g, '$$$1')
        return self.replace(pattern, replace);
      }
    ;
    };

    $opal.defn(self, '$succ', def.$next);

    def.$sum = function(n) {
      var self = this;

      if (n == null) {
        n = 16
      }
      
      var result = 0;

      for (var i = 0, length = self.length; i < length; i++) {
        result += (self.charCodeAt(i) % ((1 << n) - 1));
      }

      return result;
    
    };

    def.$swapcase = function() {
      var self = this;

      
      var str = self.replace(/([a-z]+)|([A-Z]+)/g, function($0,$1,$2) {
        return $1 ? $0.toUpperCase() : $0.toLowerCase();
      });

      if (self.constructor === String) {
        return str;
      }

      return self.$class().$new(str);
    
    };

    def.$to_f = function() {
      var self = this;

      
      if (self.charAt(0) === '_') {
        return 0;
      }

      var result = parseFloat(self.replace(/_/g, ''));

      if (isNaN(result) || result == Infinity || result == -Infinity) {
        return 0;
      }
      else {
        return result;
      }
    
    };

    def.$to_i = function(base) {
      var self = this;

      if (base == null) {
        base = 10
      }
      
      var result = parseInt(self, base);

      if (isNaN(result)) {
        return 0;
      }

      return result;
    
    };

    def.$to_proc = function() {
      var $a, $b, TMP_8, self = this;

      return ($a = ($b = self).$proc, $a._p = (TMP_8 = function(recv, args){var self = TMP_8._s || this, $a;
if (recv == null) recv = nil;args = $slice.call(arguments, 1);
      return ($a = recv).$send.apply($a, [self].concat(args))}, TMP_8._s = self, TMP_8), $a).call($b);
    };

    def.$to_s = function() {
      var self = this;

      return self.toString();
    };

    $opal.defn(self, '$to_str', def.$to_s);

    $opal.defn(self, '$to_sym', def.$intern);

    def.$tr = function(from, to) {
      var self = this;

      
      if (from.length == 0 || from === to) {
        return self;
      }

      var subs = {};
      var from_chars = from.split('');
      var from_length = from_chars.length;
      var to_chars = to.split('');
      var to_length = to_chars.length;

      var inverse = false;
      var global_sub = null;
      if (from_chars[0] === '^') {
        inverse = true;
        from_chars.shift();
        global_sub = to_chars[to_length - 1]
        from_length -= 1;
      }

      var from_chars_expanded = [];
      var last_from = null;
      var in_range = false;
      for (var i = 0; i < from_length; i++) {
        var ch = from_chars[i];
        if (last_from == null) {
          last_from = ch;
          from_chars_expanded.push(ch);
        }
        else if (ch === '-') {
          if (last_from === '-') {
            from_chars_expanded.push('-');
            from_chars_expanded.push('-');
          }
          else if (i == from_length - 1) {
            from_chars_expanded.push('-');
          }
          else {
            in_range = true;
          }
        }
        else if (in_range) {
          var start = last_from.charCodeAt(0) + 1;
          var end = ch.charCodeAt(0);
          for (var c = start; c < end; c++) {
            from_chars_expanded.push(String.fromCharCode(c));
          }
          from_chars_expanded.push(ch);
          in_range = null;
          last_from = null;
        }
        else {
          from_chars_expanded.push(ch);
        }
      }

      from_chars = from_chars_expanded;
      from_length = from_chars.length;

      if (inverse) {
        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = true;
        }
      }
      else {
        if (to_length > 0) {
          var to_chars_expanded = [];
          var last_to = null;
          var in_range = false;
          for (var i = 0; i < to_length; i++) {
            var ch = to_chars[i];
            if (last_from == null) {
              last_from = ch;
              to_chars_expanded.push(ch);
            }
            else if (ch === '-') {
              if (last_to === '-') {
                to_chars_expanded.push('-');
                to_chars_expanded.push('-');
              }
              else if (i == to_length - 1) {
                to_chars_expanded.push('-');
              }
              else {
                in_range = true;
              }
            }
            else if (in_range) {
              var start = last_from.charCodeAt(0) + 1;
              var end = ch.charCodeAt(0);
              for (var c = start; c < end; c++) {
                to_chars_expanded.push(String.fromCharCode(c));
              }
              to_chars_expanded.push(ch);
              in_range = null;
              last_from = null;
            }
            else {
              to_chars_expanded.push(ch);
            }
          }

          to_chars = to_chars_expanded;
          to_length = to_chars.length;
        }

        var length_diff = from_length - to_length;
        if (length_diff > 0) {
          var pad_char = (to_length > 0 ? to_chars[to_length - 1] : '');
          for (var i = 0; i < length_diff; i++) {
            to_chars.push(pad_char);
          }
        }

        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = to_chars[i];
        }
      }

      var new_str = ''
      for (var i = 0, length = self.length; i < length; i++) {
        var ch = self.charAt(i);
        var sub = subs[ch];
        if (inverse) {
          new_str += (sub == null ? global_sub : ch);
        }
        else {
          new_str += (sub != null ? sub : ch);
        }
      }
      return new_str;
    
    };

    def.$tr_s = function(from, to) {
      var self = this;

      
      if (from.length == 0) {
        return self;
      }

      var subs = {};
      var from_chars = from.split('');
      var from_length = from_chars.length;
      var to_chars = to.split('');
      var to_length = to_chars.length;

      var inverse = false;
      var global_sub = null;
      if (from_chars[0] === '^') {
        inverse = true;
        from_chars.shift();
        global_sub = to_chars[to_length - 1]
        from_length -= 1;
      }

      var from_chars_expanded = [];
      var last_from = null;
      var in_range = false;
      for (var i = 0; i < from_length; i++) {
        var ch = from_chars[i];
        if (last_from == null) {
          last_from = ch;
          from_chars_expanded.push(ch);
        }
        else if (ch === '-') {
          if (last_from === '-') {
            from_chars_expanded.push('-');
            from_chars_expanded.push('-');
          }
          else if (i == from_length - 1) {
            from_chars_expanded.push('-');
          }
          else {
            in_range = true;
          }
        }
        else if (in_range) {
          var start = last_from.charCodeAt(0) + 1;
          var end = ch.charCodeAt(0);
          for (var c = start; c < end; c++) {
            from_chars_expanded.push(String.fromCharCode(c));
          }
          from_chars_expanded.push(ch);
          in_range = null;
          last_from = null;
        }
        else {
          from_chars_expanded.push(ch);
        }
      }

      from_chars = from_chars_expanded;
      from_length = from_chars.length;

      if (inverse) {
        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = true;
        }
      }
      else {
        if (to_length > 0) {
          var to_chars_expanded = [];
          var last_to = null;
          var in_range = false;
          for (var i = 0; i < to_length; i++) {
            var ch = to_chars[i];
            if (last_from == null) {
              last_from = ch;
              to_chars_expanded.push(ch);
            }
            else if (ch === '-') {
              if (last_to === '-') {
                to_chars_expanded.push('-');
                to_chars_expanded.push('-');
              }
              else if (i == to_length - 1) {
                to_chars_expanded.push('-');
              }
              else {
                in_range = true;
              }
            }
            else if (in_range) {
              var start = last_from.charCodeAt(0) + 1;
              var end = ch.charCodeAt(0);
              for (var c = start; c < end; c++) {
                to_chars_expanded.push(String.fromCharCode(c));
              }
              to_chars_expanded.push(ch);
              in_range = null;
              last_from = null;
            }
            else {
              to_chars_expanded.push(ch);
            }
          }

          to_chars = to_chars_expanded;
          to_length = to_chars.length;
        }

        var length_diff = from_length - to_length;
        if (length_diff > 0) {
          var pad_char = (to_length > 0 ? to_chars[to_length - 1] : '');
          for (var i = 0; i < length_diff; i++) {
            to_chars.push(pad_char);
          }
        }

        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = to_chars[i];
        }
      }
      var new_str = ''
      var last_substitute = null
      for (var i = 0, length = self.length; i < length; i++) {
        var ch = self.charAt(i);
        var sub = subs[ch]
        if (inverse) {
          if (sub == null) {
            if (last_substitute == null) {
              new_str += global_sub;
              last_substitute = true;
            }
          }
          else {
            new_str += ch;
            last_substitute = null;
          }
        }
        else {
          if (sub != null) {
            if (last_substitute == null || last_substitute !== sub) {
              new_str += sub;
              last_substitute = sub;
            }
          }
          else {
            new_str += ch;
            last_substitute = null;
          }
        }
      }
      return new_str;
    
    };

    def.$upcase = function() {
      var self = this;

      return self.toUpperCase();
    };

    def.$freeze = function() {
      var self = this;

      return self;
    };

    return (def['$frozen?'] = function() {
      var self = this;

      return true;
    }, nil) && 'frozen?';
  })(self, null);
  return $opal.cdecl($scope, 'Symbol', (($a = $scope.String) == null ? $opal.cm('String') : $a));
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/string.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$new', '$allocate', '$initialize', '$to_proc', '$__send__', '$class', '$clone', '$respond_to?', '$==', '$inspect']);
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self._proto, $scope = self._scope;

    return ($opal.defs(self, '$inherited', function(klass) {
      var $a, $b, self = this, replace = nil;

      replace = (($a = $scope.Class) == null ? $opal.cm('Class') : $a).$new((($a = ((($b = $scope.String) == null ? $opal.cm('String') : $b))._scope).Wrapper == null ? $a.cm('Wrapper') : $a.Wrapper));
      
      klass._proto        = replace._proto;
      klass._proto._klass = klass;
      klass._alloc        = replace._alloc;
      klass.__parent      = (($a = ((($b = $scope.String) == null ? $opal.cm('String') : $b))._scope).Wrapper == null ? $a.cm('Wrapper') : $a.Wrapper);

      klass.$allocate = replace.$allocate;
      klass.$new      = replace.$new;
    
    }), nil) && 'inherited'
  })(self, null);
  return (function($base, $super) {
    function $Wrapper(){};
    var self = $Wrapper = $klass($base, $super, 'Wrapper', $Wrapper);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4;

    def.literal = nil;
    $opal.defs(self, '$allocate', TMP_1 = function(string) {
      var self = this, $iter = TMP_1._p, $yield = $iter || nil, obj = nil;

      if (string == null) {
        string = ""
      }
      TMP_1._p = null;
      obj = $opal.find_super_dispatcher(self, 'allocate', TMP_1, null, $Wrapper).apply(self, []);
      obj.literal = string;
      return obj;
    });

    $opal.defs(self, '$new', TMP_2 = function(args) {
      var $a, $b, self = this, $iter = TMP_2._p, block = $iter || nil, obj = nil;

      args = $slice.call(arguments, 0);
      TMP_2._p = null;
      obj = self.$allocate();
      ($a = ($b = obj).$initialize, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
      return obj;
    });

    $opal.defs(self, '$[]', function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      return self.$allocate(objects);
    });

    def.$initialize = function(string) {
      var self = this;

      if (string == null) {
        string = ""
      }
      return self.literal = string;
    };

    def.$method_missing = TMP_3 = function(args) {
      var $a, $b, self = this, $iter = TMP_3._p, block = $iter || nil, result = nil;

      args = $slice.call(arguments, 0);
      TMP_3._p = null;
      result = ($a = ($b = self.literal).$__send__, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
      if ((($a = result._isString != null) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = result == self.literal) !== nil && (!$a._isBoolean || $a == true))) {
          return self
          } else {
          return self.$class().$allocate(result)
        }
        } else {
        return result
      };
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return self.literal = (other.literal).$clone();
    };

    def['$respond_to?'] = TMP_4 = function(name) {var $zuper = $slice.call(arguments, 0);
      var $a, self = this, $iter = TMP_4._p, $yield = $iter || nil;

      TMP_4._p = null;
      return ((($a = $opal.find_super_dispatcher(self, 'respond_to?', TMP_4, $iter).apply(self, $zuper)) !== false && $a !== nil) ? $a : self.literal['$respond_to?'](name));
    };

    def['$=='] = function(other) {
      var self = this;

      return self.literal['$=='](other);
    };

    $opal.defn(self, '$eql?', def['$==']);

    $opal.defn(self, '$===', def['$==']);

    def.$to_s = function() {
      var self = this;

      return self.literal;
    };

    def.$to_str = function() {
      var self = this;

      return self;
    };

    return (def.$inspect = function() {
      var self = this;

      return self.literal.$inspect();
    }, nil) && 'inspect';
  })((($a = $scope.String) == null ? $opal.cm('String') : $a), null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/string/inheritance.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$attr_reader', '$pre_match', '$post_match', '$[]', '$===', '$!', '$==', '$raise', '$inspect']);
  return (function($base, $super) {
    function $MatchData(){};
    var self = $MatchData = $klass($base, $super, 'MatchData', $MatchData);

    var def = self._proto, $scope = self._scope, TMP_1;

    def.string = def.matches = def.begin = nil;
    self.$attr_reader("post_match", "pre_match", "regexp", "string");

    $opal.defs(self, '$new', TMP_1 = function(regexp, match_groups) {
      var self = this, $iter = TMP_1._p, $yield = $iter || nil, data = nil;

      TMP_1._p = null;
      data = $opal.find_super_dispatcher(self, 'new', TMP_1, null, $MatchData).apply(self, [regexp, match_groups]);
      $gvars["`"] = data.$pre_match();
      $gvars["'"] = data.$post_match();
      $gvars["~"] = data;
      return data;
    });

    def.$initialize = function(regexp, match_groups) {
      var self = this;

      self.regexp = regexp;
      self.begin = match_groups.index;
      self.string = match_groups.input;
      self.pre_match = self.string.substr(0, regexp.lastIndex - match_groups[0].length);
      self.post_match = self.string.substr(regexp.lastIndex);
      self.matches = [];
      
      for (var i = 0, length = match_groups.length; i < length; i++) {
        var group = match_groups[i];

        if (group == null) {
          self.matches.push(nil);
        }
        else {
          self.matches.push(group);
        }
      }
    
    };

    def['$[]'] = function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      return ($a = self.matches)['$[]'].apply($a, [].concat(args));
    };

    def['$=='] = function(other) {
      var $a, $b, $c, $d, self = this;

      if ((($a = (($b = $scope.MatchData) == null ? $opal.cm('MatchData') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      return ($a = ($b = ($c = ($d = self.string == other.string, $d !== false && $d !== nil ?self.regexp == other.regexp : $d), $c !== false && $c !== nil ?self.pre_match == other.pre_match : $c), $b !== false && $b !== nil ?self.post_match == other.post_match : $b), $a !== false && $a !== nil ?self.begin == other.begin : $a);
    };

    def.$begin = function(pos) {
      var $a, $b, self = this;

      if ((($a = ($b = pos['$=='](0)['$!'](), $b !== false && $b !== nil ?pos['$=='](1)['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "MatchData#begin only supports 0th element")};
      return self.begin;
    };

    def.$captures = function() {
      var self = this;

      return self.matches.slice(1);
    };

    def.$inspect = function() {
      var self = this;

      
      var str = "#<MatchData " + (self.matches[0]).$inspect();

      for (var i = 1, length = self.matches.length; i < length; i++) {
        str += " " + i + ":" + (self.matches[i]).$inspect();
      }

      return str + ">";
    ;
    };

    def.$length = function() {
      var self = this;

      return self.matches.length;
    };

    $opal.defn(self, '$size', def.$length);

    def.$to_a = function() {
      var self = this;

      return self.matches;
    };

    def.$to_s = function() {
      var self = this;

      return self.matches[0];
    };

    return (def.$values_at = function(indexes) {
      var self = this;

      indexes = $slice.call(arguments, 0);
      
      var values       = [],
          match_length = self.matches.length;

      for (var i = 0, length = indexes.length; i < length; i++) {
        var pos = indexes[i];

        if (pos >= 0) {
          values.push(self.matches[pos]);
        }
        else {
          pos += match_length;

          if (pos > 0) {
            values.push(self.matches[pos]);
          }
          else {
            values.push(nil);
          }
        }
      }

      return values;
    ;
    }, nil) && 'values_at';
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/match_data.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$coerce', '$===', '$raise', '$class', '$__send__', '$send_coerced', '$to_int', '$coerce_to!', '$-@', '$**', '$-', '$respond_to?', '$==', '$enum_for', '$gcd', '$lcm', '$<', '$>', '$floor', '$/', '$%']);
  ;
  (function($base, $super) {
    function $Numeric(){};
    var self = $Numeric = $klass($base, $super, 'Numeric', $Numeric);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6;

    self.$include((($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a));

    def._isNumber = true;

    def.$coerce = function(other, type) {
      var $a, self = this, $case = nil;

      if (type == null) {
        type = "operation"
      }
      try {
      
      if (other._isNumber) {
        return [self, other];
      }
      else {
        return other.$coerce(self);
      }
    
      } catch ($err) {if (true) {
        return (function() {$case = type;if ("operation"['$===']($case)) {return self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "" + (other.$class()) + " can't be coerce into Numeric")}else if ("comparison"['$===']($case)) {return self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")}else { return nil }})()
        }else { throw $err; }
      };
    };

    def.$send_coerced = function(method, other) {
      var $a, self = this, type = nil, $case = nil, a = nil, b = nil;

      type = (function() {$case = method;if ("+"['$===']($case) || "-"['$===']($case) || "*"['$===']($case) || "/"['$===']($case) || "%"['$===']($case) || "&"['$===']($case) || "|"['$===']($case) || "^"['$===']($case) || "**"['$===']($case)) {return "operation"}else if (">"['$===']($case) || ">="['$===']($case) || "<"['$===']($case) || "<="['$===']($case) || "<=>"['$===']($case)) {return "comparison"}else { return nil }})();
      $a = $opal.to_ary(self.$coerce(other, type)), a = ($a[0] == null ? nil : $a[0]), b = ($a[1] == null ? nil : $a[1]);
      return a.$__send__(method, b);
    };

    def['$+'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self + other;
      }
      else {
        return self.$send_coerced("+", other);
      }
    
    };

    def['$-'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self - other;
      }
      else {
        return self.$send_coerced("-", other);
      }
    
    };

    def['$*'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self * other;
      }
      else {
        return self.$send_coerced("*", other);
      }
    
    };

    def['$/'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self / other;
      }
      else {
        return self.$send_coerced("/", other);
      }
    
    };

    def['$%'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        if (other < 0 || self < 0) {
          return (self % other + other) % other;
        }
        else {
          return self % other;
        }
      }
      else {
        return self.$send_coerced("%", other);
      }
    
    };

    def['$&'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self & other;
      }
      else {
        return self.$send_coerced("&", other);
      }
    
    };

    def['$|'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self | other;
      }
      else {
        return self.$send_coerced("|", other);
      }
    
    };

    def['$^'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self ^ other;
      }
      else {
        return self.$send_coerced("^", other);
      }
    
    };

    def['$<'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self < other;
      }
      else {
        return self.$send_coerced("<", other);
      }
    
    };

    def['$<='] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self <= other;
      }
      else {
        return self.$send_coerced("<=", other);
      }
    
    };

    def['$>'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self > other;
      }
      else {
        return self.$send_coerced(">", other);
      }
    
    };

    def['$>='] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self >= other;
      }
      else {
        return self.$send_coerced(">=", other);
      }
    
    };

    def['$<=>'] = function(other) {
      var $a, self = this;

      try {
      
      if (other._isNumber) {
        return self > other ? 1 : (self < other ? -1 : 0);
      }
      else {
        return self.$send_coerced("<=>", other);
      }
    
      } catch ($err) {if ($opal.$rescue($err, [(($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a)])) {
        return nil
        }else { throw $err; }
      };
    };

    def['$<<'] = function(count) {
      var self = this;

      return self << count.$to_int();
    };

    def['$>>'] = function(count) {
      var self = this;

      return self >> count.$to_int();
    };

    def['$[]'] = function(bit) {
      var $a, self = this, min = nil, max = nil;

      bit = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](bit, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      min = ((2)['$**'](30))['$-@']();
      max = ((2)['$**'](30))['$-'](1);
      return (bit < min || bit > max) ? 0 : (self >> bit) % 2;
    };

    def['$+@'] = function() {
      var self = this;

      return +self;
    };

    def['$-@'] = function() {
      var self = this;

      return -self;
    };

    def['$~'] = function() {
      var self = this;

      return ~self;
    };

    def['$**'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return Math.pow(self, other);
      }
      else {
        return self.$send_coerced("**", other);
      }
    
    };

    def['$=='] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self == Number(other);
      }
      else if (other['$respond_to?']("==")) {
        return other['$=='](self);
      }
      else {
        return false;
      }
    ;
    };

    def.$abs = function() {
      var self = this;

      return Math.abs(self);
    };

    def.$ceil = function() {
      var self = this;

      return Math.ceil(self);
    };

    def.$chr = function() {
      var self = this;

      return String.fromCharCode(self);
    };

    def.$conj = function() {
      var self = this;

      return self;
    };

    $opal.defn(self, '$conjugate', def.$conj);

    def.$downto = TMP_1 = function(finish) {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("downto", finish)
      };
      
      for (var i = self; i >= finish; i--) {
        if (block(i) === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    $opal.defn(self, '$eql?', def['$==']);

    $opal.defn(self, '$equal?', def['$==']);

    def['$even?'] = function() {
      var self = this;

      return self % 2 === 0;
    };

    def.$floor = function() {
      var self = this;

      return Math.floor(self);
    };

    def.$gcd = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "not an integer")
      };
      
      var min = Math.abs(self),
          max = Math.abs(other);

      while (min > 0) {
        var tmp = min;

        min = max % min;
        max = tmp;
      }

      return max;
    
    };

    def.$gcdlcm = function(other) {
      var self = this;

      return [self.$gcd(), self.$lcm()];
    };

    def.$hash = function() {
      var self = this;

      return self.toString();
    };

    def['$integer?'] = function() {
      var self = this;

      return self % 1 === 0;
    };

    def['$is_a?'] = TMP_2 = function(klass) {var $zuper = $slice.call(arguments, 0);
      var $a, $b, $c, self = this, $iter = TMP_2._p, $yield = $iter || nil;

      TMP_2._p = null;
      if ((($a = (($b = klass['$==']((($c = $scope.Fixnum) == null ? $opal.cm('Fixnum') : $c))) ? (($c = $scope.Integer) == null ? $opal.cm('Integer') : $c)['$==='](self) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']((($c = $scope.Integer) == null ? $opal.cm('Integer') : $c))) ? (($c = $scope.Integer) == null ? $opal.cm('Integer') : $c)['$==='](self) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']((($c = $scope.Float) == null ? $opal.cm('Float') : $c))) ? (($c = $scope.Float) == null ? $opal.cm('Float') : $c)['$==='](self) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      return $opal.find_super_dispatcher(self, 'is_a?', TMP_2, $iter).apply(self, $zuper);
    };

    $opal.defn(self, '$kind_of?', def['$is_a?']);

    def['$instance_of?'] = TMP_3 = function(klass) {var $zuper = $slice.call(arguments, 0);
      var $a, $b, $c, self = this, $iter = TMP_3._p, $yield = $iter || nil;

      TMP_3._p = null;
      if ((($a = (($b = klass['$==']((($c = $scope.Fixnum) == null ? $opal.cm('Fixnum') : $c))) ? (($c = $scope.Integer) == null ? $opal.cm('Integer') : $c)['$==='](self) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']((($c = $scope.Integer) == null ? $opal.cm('Integer') : $c))) ? (($c = $scope.Integer) == null ? $opal.cm('Integer') : $c)['$==='](self) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']((($c = $scope.Float) == null ? $opal.cm('Float') : $c))) ? (($c = $scope.Float) == null ? $opal.cm('Float') : $c)['$==='](self) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      return $opal.find_super_dispatcher(self, 'instance_of?', TMP_3, $iter).apply(self, $zuper);
    };

    def.$lcm = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "not an integer")
      };
      
      if (self == 0 || other == 0) {
        return 0;
      }
      else {
        return Math.abs(self * other / self.$gcd(other));
      }
    
    };

    $opal.defn(self, '$magnitude', def.$abs);

    $opal.defn(self, '$modulo', def['$%']);

    def.$next = function() {
      var self = this;

      return self + 1;
    };

    def['$nonzero?'] = function() {
      var self = this;

      return self == 0 ? nil : self;
    };

    def['$odd?'] = function() {
      var self = this;

      return self % 2 !== 0;
    };

    def.$ord = function() {
      var self = this;

      return self;
    };

    def.$pred = function() {
      var self = this;

      return self - 1;
    };

    def.$round = function() {
      var self = this;

      return Math.round(self);
    };

    def.$step = TMP_4 = function(limit, step) {
      var $a, self = this, $iter = TMP_4._p, block = $iter || nil;

      if (step == null) {
        step = 1
      }
      TMP_4._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("step", limit, step)
      };
      if ((($a = step == 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "step cannot be 0")};
      
      var value = self;

      if (step > 0) {
        while (value <= limit) {
          block(value);
          value += step;
        }
      }
      else {
        while (value >= limit) {
          block(value);
          value += step;
        }
      }
    
      return self;
    };

    $opal.defn(self, '$succ', def.$next);

    def.$times = TMP_5 = function() {
      var self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("times")
      };
      
      for (var i = 0; i < self; i++) {
        if (block(i) === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def.$to_f = function() {
      var self = this;

      return self;
    };

    def.$to_i = function() {
      var self = this;

      return parseInt(self);
    };

    $opal.defn(self, '$to_int', def.$to_i);

    def.$to_s = function(base) {
      var $a, $b, self = this;

      if (base == null) {
        base = 10
      }
      if ((($a = ((($b = base['$<'](2)) !== false && $b !== nil) ? $b : base['$>'](36))) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "base must be between 2 and 36")};
      return self.toString(base);
    };

    $opal.defn(self, '$inspect', def.$to_s);

    def.$divmod = function(rhs) {
      var self = this, q = nil, r = nil;

      q = (self['$/'](rhs)).$floor();
      r = self['$%'](rhs);
      return [q, r];
    };

    def.$upto = TMP_6 = function(finish) {
      var self = this, $iter = TMP_6._p, block = $iter || nil;

      TMP_6._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("upto", finish)
      };
      
      for (var i = self; i <= finish; i++) {
        if (block(i) === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def['$zero?'] = function() {
      var self = this;

      return self == 0;
    };

    def.$size = function() {
      var self = this;

      return 4;
    };

    def['$nan?'] = function() {
      var self = this;

      return isNaN(self);
    };

    def['$finite?'] = function() {
      var self = this;

      return self != Infinity && self != -Infinity;
    };

    def['$infinite?'] = function() {
      var self = this;

      
      if (self == Infinity) {
        return +1;
      }
      else if (self == -Infinity) {
        return -1;
      }
      else {
        return nil;
      }
    
    };

    def['$positive?'] = function() {
      var self = this;

      return 1 / self > 0;
    };

    return (def['$negative?'] = function() {
      var self = this;

      return 1 / self < 0;
    }, nil) && 'negative?';
  })(self, null);
  $opal.cdecl($scope, 'Fixnum', (($a = $scope.Numeric) == null ? $opal.cm('Numeric') : $a));
  (function($base, $super) {
    function $Integer(){};
    var self = $Integer = $klass($base, $super, 'Integer', $Integer);

    var def = self._proto, $scope = self._scope;

    return ($opal.defs(self, '$===', function(other) {
      var self = this;

      
      if (!other._isNumber) {
        return false;
      }

      return (other % 1) === 0;
    
    }), nil) && '==='
  })(self, (($a = $scope.Numeric) == null ? $opal.cm('Numeric') : $a));
  return (function($base, $super) {
    function $Float(){};
    var self = $Float = $klass($base, $super, 'Float', $Float);

    var def = self._proto, $scope = self._scope, $a;

    $opal.defs(self, '$===', function(other) {
      var self = this;

      return !!other._isNumber;
    });

    $opal.cdecl($scope, 'INFINITY', Infinity);

    $opal.cdecl($scope, 'NAN', NaN);

    if ((($a = (typeof(Number.EPSILON) !== "undefined")) !== nil && (!$a._isBoolean || $a == true))) {
      return $opal.cdecl($scope, 'EPSILON', Number.EPSILON)
      } else {
      return $opal.cdecl($scope, 'EPSILON', 2.2204460492503130808472633361816E-16)
    };
  })(self, (($a = $scope.Numeric) == null ? $opal.cm('Numeric') : $a));
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/numeric.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs([]);
  return (function($base, $super) {
    function $Complex(){};
    var self = $Complex = $klass($base, $super, 'Complex', $Complex);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.Numeric) == null ? $opal.cm('Numeric') : $a))
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/complex.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs([]);
  return (function($base, $super) {
    function $Rational(){};
    var self = $Rational = $klass($base, $super, 'Rational', $Rational);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.Numeric) == null ? $opal.cm('Numeric') : $a))
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/rational.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$raise']);
  return (function($base, $super) {
    function $Proc(){};
    var self = $Proc = $klass($base, $super, 'Proc', $Proc);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2;

    def._isProc = true;

    def.is_lambda = false;

    $opal.defs(self, '$new', TMP_1 = function() {
      var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      if (block !== false && block !== nil) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to create a Proc object without a block")
      };
      return block;
    });

    def.$call = TMP_2 = function(args) {
      var self = this, $iter = TMP_2._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_2._p = null;
      
      if (block !== nil) {
        self._p = block;
      }

      var result;

      if (self.is_lambda) {
        result = self.apply(null, args);
      }
      else {
        result = Opal.$yieldX(self, args);
      }

      if (result === $breaker) {
        return $breaker.$v;
      }

      return result;
    
    };

    $opal.defn(self, '$[]', def.$call);

    def.$to_proc = function() {
      var self = this;

      return self;
    };

    def['$lambda?'] = function() {
      var self = this;

      return !!self.is_lambda;
    };

    return (def.$arity = function() {
      var self = this;

      return self.length;
    }, nil) && 'arity';
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/proc.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$attr_reader', '$class', '$arity', '$new', '$name']);
  (function($base, $super) {
    function $Method(){};
    var self = $Method = $klass($base, $super, 'Method', $Method);

    var def = self._proto, $scope = self._scope, TMP_1;

    def.method = def.receiver = def.owner = def.name = def.obj = nil;
    self.$attr_reader("owner", "receiver", "name");

    def.$initialize = function(receiver, method, name) {
      var self = this;

      self.receiver = receiver;
      self.owner = receiver.$class();
      self.name = name;
      return self.method = method;
    };

    def.$arity = function() {
      var self = this;

      return self.method.$arity();
    };

    def.$call = TMP_1 = function(args) {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_1._p = null;
      
      self.method._p = block;

      return self.method.apply(self.receiver, args);
    ;
    };

    $opal.defn(self, '$[]', def.$call);

    def.$unbind = function() {
      var $a, self = this;

      return (($a = $scope.UnboundMethod) == null ? $opal.cm('UnboundMethod') : $a).$new(self.owner, self.method, self.name);
    };

    def.$to_proc = function() {
      var self = this;

      return self.method;
    };

    return (def.$inspect = function() {
      var self = this;

      return "#<Method: " + (self.obj.$class().$name()) + "#" + (self.name) + "}>";
    }, nil) && 'inspect';
  })(self, null);
  return (function($base, $super) {
    function $UnboundMethod(){};
    var self = $UnboundMethod = $klass($base, $super, 'UnboundMethod', $UnboundMethod);

    var def = self._proto, $scope = self._scope;

    def.method = def.name = def.owner = nil;
    self.$attr_reader("owner", "name");

    def.$initialize = function(owner, method, name) {
      var self = this;

      self.owner = owner;
      self.method = method;
      return self.name = name;
    };

    def.$arity = function() {
      var self = this;

      return self.method.$arity();
    };

    def.$bind = function(object) {
      var $a, self = this;

      return (($a = $scope.Method) == null ? $opal.cm('Method') : $a).$new(object, self.method, self.name);
    };

    return (def.$inspect = function() {
      var self = this;

      return "#<UnboundMethod: " + (self.owner.$name()) + "#" + (self.name) + ">";
    }, nil) && 'inspect';
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/method.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$attr_reader', '$<=', '$<', '$enum_for', '$succ', '$!', '$==', '$===', '$exclude_end?', '$eql?', '$begin', '$end', '$-', '$abs', '$to_i', '$raise', '$inspect']);
  ;
  return (function($base, $super) {
    function $Range(){};
    var self = $Range = $klass($base, $super, 'Range', $Range);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3;

    def.begin = def.exclude = def.end = nil;
    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    def._isRange = true;

    self.$attr_reader("begin", "end");

    def.$initialize = function(first, last, exclude) {
      var self = this;

      if (exclude == null) {
        exclude = false
      }
      self.begin = first;
      self.end = last;
      return self.exclude = exclude;
    };

    def['$=='] = function(other) {
      var self = this;

      
      if (!other._isRange) {
        return false;
      }

      return self.exclude === other.exclude &&
             self.begin   ==  other.begin &&
             self.end     ==  other.end;
    
    };

    def['$==='] = function(value) {
      var $a, $b, self = this;

      return (($a = self.begin['$<='](value)) ? ((function() {if ((($b = self.exclude) !== nil && (!$b._isBoolean || $b == true))) {
        return value['$<'](self.end)
        } else {
        return value['$<='](self.end)
      }; return nil; })()) : $a);
    };

    $opal.defn(self, '$cover?', def['$===']);

    def.$each = TMP_1 = function() {
      var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil, current = nil, last = nil;

      TMP_1._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      current = self.begin;
      last = self.end;
      while (current['$<'](last)) {
      if ($opal.$yield1(block, current) === $breaker) return $breaker.$v;
      current = current.$succ();};
      if ((($a = ($b = self.exclude['$!'](), $b !== false && $b !== nil ?current['$=='](last) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        if ($opal.$yield1(block, current) === $breaker) return $breaker.$v};
      return self;
    };

    def['$eql?'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Range) == null ? $opal.cm('Range') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      return ($a = ($b = self.exclude['$==='](other['$exclude_end?']()), $b !== false && $b !== nil ?self.begin['$eql?'](other.$begin()) : $b), $a !== false && $a !== nil ?self.end['$eql?'](other.$end()) : $a);
    };

    def['$exclude_end?'] = function() {
      var self = this;

      return self.exclude;
    };

    $opal.defn(self, '$first', def.$begin);

    $opal.defn(self, '$include?', def['$cover?']);

    $opal.defn(self, '$last', def.$end);

    def.$max = TMP_2 = function() {var $zuper = $slice.call(arguments, 0);
      var self = this, $iter = TMP_2._p, $yield = $iter || nil;

      TMP_2._p = null;
      if (($yield !== nil)) {
        return $opal.find_super_dispatcher(self, 'max', TMP_2, $iter).apply(self, $zuper)
        } else {
        return self.exclude ? self.end - 1 : self.end;
      };
    };

    $opal.defn(self, '$member?', def['$cover?']);

    def.$min = TMP_3 = function() {var $zuper = $slice.call(arguments, 0);
      var self = this, $iter = TMP_3._p, $yield = $iter || nil;

      TMP_3._p = null;
      if (($yield !== nil)) {
        return $opal.find_super_dispatcher(self, 'min', TMP_3, $iter).apply(self, $zuper)
        } else {
        return self.begin
      };
    };

    $opal.defn(self, '$member?', def['$include?']);

    def.$size = function() {
      var $a, $b, $c, self = this, _begin = nil, _end = nil, infinity = nil;

      _begin = self.begin;
      _end = self.end;
      if ((($a = self.exclude) !== nil && (!$a._isBoolean || $a == true))) {
        _end = _end['$-'](1)};
      if ((($a = ($b = (($c = $scope.Numeric) == null ? $opal.cm('Numeric') : $c)['$==='](_begin), $b !== false && $b !== nil ?(($c = $scope.Numeric) == null ? $opal.cm('Numeric') : $c)['$==='](_end) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return nil
      };
      if (_end['$<'](_begin)) {
        return 0};
      infinity = (($a = ((($b = $scope.Float) == null ? $opal.cm('Float') : $b))._scope).INFINITY == null ? $a.cm('INFINITY') : $a.INFINITY);
      if ((($a = ((($b = infinity['$=='](_begin.$abs())) !== false && $b !== nil) ? $b : _end.$abs()['$=='](infinity))) !== nil && (!$a._isBoolean || $a == true))) {
        return infinity};
      return ((Math.abs(_end - _begin) + 1)).$to_i();
    };

    def.$step = function(n) {
      var $a, self = this;

      if (n == null) {
        n = 1
      }
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def.$to_s = function() {
      var self = this;

      return self.begin.$inspect() + (self.exclude ? '...' : '..') + self.end.$inspect();
    };

    return $opal.defn(self, '$inspect', def.$to_s);
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/range.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$kind_of?', '$to_i', '$coerce_to', '$between?', '$raise', '$new', '$compact', '$nil?', '$===', '$<=>', '$to_f', '$strftime', '$is_a?', '$zero?', '$utc?', '$warn', '$yday', '$rjust', '$ljust', '$zone', '$sec', '$min', '$hour', '$day', '$month', '$year', '$wday', '$isdst']);
  ;
  return (function($base, $super) {
    function $Time(){};
    var self = $Time = $klass($base, $super, 'Time', $Time);

    var def = self._proto, $scope = self._scope, $a;

    self.$include((($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a));

    
    var days_of_week = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        short_days   = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        short_months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
        long_months  = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  ;

    $opal.defs(self, '$at', function(seconds, frac) {
      var self = this;

      if (frac == null) {
        frac = 0
      }
      return new Date(seconds * 1000 + frac);
    });

    $opal.defs(self, '$new', function(year, month, day, hour, minute, second, utc_offset) {
      var self = this;

      
      switch (arguments.length) {
        case 1:
          return new Date(year, 0);

        case 2:
          return new Date(year, month - 1);

        case 3:
          return new Date(year, month - 1, day);

        case 4:
          return new Date(year, month - 1, day, hour);

        case 5:
          return new Date(year, month - 1, day, hour, minute);

        case 6:
          return new Date(year, month - 1, day, hour, minute, second);

        case 7:
          return new Date(year, month - 1, day, hour, minute, second);

        default:
          return new Date();
      }
    
    });

    $opal.defs(self, '$local', function(year, month, day, hour, minute, second, millisecond) {
      var $a, $b, self = this;

      if (month == null) {
        month = nil
      }
      if (day == null) {
        day = nil
      }
      if (hour == null) {
        hour = nil
      }
      if (minute == null) {
        minute = nil
      }
      if (second == null) {
        second = nil
      }
      if (millisecond == null) {
        millisecond = nil
      }
      if ((($a = arguments.length === 10) !== nil && (!$a._isBoolean || $a == true))) {
        
        var args = $slice.call(arguments).reverse();

        second = args[9];
        minute = args[8];
        hour   = args[7];
        day    = args[6];
        month  = args[5];
        year   = args[4];
      };
      year = (function() {if ((($a = year['$kind_of?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        return year.$to_i()
        } else {
        return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(year, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
      }; return nil; })();
      month = (function() {if ((($a = month['$kind_of?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        return month.$to_i()
        } else {
        return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(((($a = month) !== false && $a !== nil) ? $a : 1), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
      }; return nil; })();
      if ((($a = month['$between?'](1, 12)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "month out of range: " + (month))
      };
      day = (function() {if ((($a = day['$kind_of?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        return day.$to_i()
        } else {
        return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(((($a = day) !== false && $a !== nil) ? $a : 1), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
      }; return nil; })();
      if ((($a = day['$between?'](1, 31)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "day out of range: " + (day))
      };
      hour = (function() {if ((($a = hour['$kind_of?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        return hour.$to_i()
        } else {
        return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(((($a = hour) !== false && $a !== nil) ? $a : 0), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
      }; return nil; })();
      if ((($a = hour['$between?'](0, 24)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "hour out of range: " + (hour))
      };
      minute = (function() {if ((($a = minute['$kind_of?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        return minute.$to_i()
        } else {
        return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(((($a = minute) !== false && $a !== nil) ? $a : 0), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
      }; return nil; })();
      if ((($a = minute['$between?'](0, 59)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "minute out of range: " + (minute))
      };
      second = (function() {if ((($a = second['$kind_of?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        return second.$to_i()
        } else {
        return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(((($a = second) !== false && $a !== nil) ? $a : 0), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
      }; return nil; })();
      if ((($a = second['$between?'](0, 59)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "second out of range: " + (second))
      };
      return ($a = self).$new.apply($a, [].concat([year, month, day, hour, minute, second].$compact()));
    });

    $opal.defs(self, '$gm', function(year, month, day, hour, minute, second, utc_offset) {
      var $a, self = this;

      if ((($a = year['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "missing year (got nil)")};
      
      if (month > 12 || day > 31 || hour > 24 || minute > 59 || second > 59) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a));
      }

      var date = new Date(Date.UTC(year, (month || 1) - 1, (day || 1), (hour || 0), (minute || 0), (second || 0)));
      date.tz_offset = 0
      return date;
    ;
    });

    (function(self) {
      var $scope = self._scope, def = self._proto;

      self._proto.$mktime = self._proto.$local;
      return self._proto.$utc = self._proto.$gm;
    })(self.$singleton_class());

    $opal.defs(self, '$now', function() {
      var self = this;

      return new Date();
    });

    def['$+'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Time) == null ? $opal.cm('Time') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "time + time?")};
      other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      
      var result = new Date(self.getTime() + (other * 1000));
      result.tz_offset = self.tz_offset;
      return result;
    
    };

    def['$-'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Time) == null ? $opal.cm('Time') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        return (self.getTime() - other.getTime()) / 1000;
        } else {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        
        var result = new Date(self.getTime() - (other * 1000));
        result.tz_offset = self.tz_offset;
        return result;
      
      };
    };

    def['$<=>'] = function(other) {
      var self = this;

      return self.$to_f()['$<=>'](other.$to_f());
    };

    def['$=='] = function(other) {
      var self = this;

      return self.$to_f() === other.$to_f();
    };

    def.$asctime = function() {
      var self = this;

      return self.$strftime("%a %b %e %H:%M:%S %Y");
    };

    $opal.defn(self, '$ctime', def.$asctime);

    def.$day = function() {
      var self = this;

      return self.getDate();
    };

    def.$yday = function() {
      var self = this;

      
      // http://javascript.about.com/library/bldayyear.htm
      var onejan = new Date(self.getFullYear(), 0, 1);
      return Math.ceil((self - onejan) / 86400000);
    
    };

    def.$isdst = function() {
      var $a, self = this;

      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def['$eql?'] = function(other) {
      var $a, $b, self = this;

      return ($a = other['$is_a?']((($b = $scope.Time) == null ? $opal.cm('Time') : $b)), $a !== false && $a !== nil ?(self['$<=>'](other))['$zero?']() : $a);
    };

    def['$friday?'] = function() {
      var self = this;

      return self.getDay() === 5;
    };

    def.$hour = function() {
      var self = this;

      return self.getHours();
    };

    def.$inspect = function() {
      var $a, self = this;

      if ((($a = self['$utc?']()) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$strftime("%Y-%m-%d %H:%M:%S UTC")
        } else {
        return self.$strftime("%Y-%m-%d %H:%M:%S %z")
      };
    };

    $opal.defn(self, '$mday', def.$day);

    def.$min = function() {
      var self = this;

      return self.getMinutes();
    };

    def.$mon = function() {
      var self = this;

      return self.getMonth() + 1;
    };

    def['$monday?'] = function() {
      var self = this;

      return self.getDay() === 1;
    };

    $opal.defn(self, '$month', def.$mon);

    def['$saturday?'] = function() {
      var self = this;

      return self.getDay() === 6;
    };

    def.$sec = function() {
      var self = this;

      return self.getSeconds();
    };

    def.$usec = function() {
      var self = this;

      self.$warn("Microseconds are not supported");
      return 0;
    };

    def.$zone = function() {
      var self = this;

      
      var string = self.toString(),
          result;

      if (string.indexOf('(') == -1) {
        result = string.match(/[A-Z]{3,4}/)[0];
      }
      else {
        result = string.match(/\([^)]+\)/)[0].match(/[A-Z]/g).join('');
      }

      if (result == "GMT" && /(GMT\W*\d{4})/.test(string)) {
        return RegExp.$1;
      }
      else {
        return result;
      }
    
    };

    def.$getgm = function() {
      var self = this;

      
      var result = new Date(self.getTime());
      result.tz_offset = 0;
      return result;
    
    };

    def['$gmt?'] = function() {
      var self = this;

      return self.tz_offset == 0;
    };

    def.$gmt_offset = function() {
      var self = this;

      return -self.getTimezoneOffset() * 60;
    };

    def.$strftime = function(format) {
      var self = this;

      
      return format.replace(/%([\-_#^0]*:{0,2})(\d+)?([EO]*)(.)/g, function(full, flags, width, _, conv) {
        var result = "",
            width  = parseInt(width),
            zero   = flags.indexOf('0') !== -1,
            pad    = flags.indexOf('-') === -1,
            blank  = flags.indexOf('_') !== -1,
            upcase = flags.indexOf('^') !== -1,
            invert = flags.indexOf('#') !== -1,
            colons = (flags.match(':') || []).length;

        if (zero && blank) {
          if (flags.indexOf('0') < flags.indexOf('_')) {
            zero = false;
          }
          else {
            blank = false;
          }
        }

        switch (conv) {
          case 'Y':
            result += self.getFullYear();
            break;

          case 'C':
            zero    = !blank;
            result += Match.round(self.getFullYear() / 100);
            break;

          case 'y':
            zero    = !blank;
            result += (self.getFullYear() % 100);
            break;

          case 'm':
            zero    = !blank;
            result += (self.getMonth() + 1);
            break;

          case 'B':
            result += long_months[self.getMonth()];
            break;

          case 'b':
          case 'h':
            blank   = !zero;
            result += short_months[self.getMonth()];
            break;

          case 'd':
            zero    = !blank
            result += self.getDate();
            break;

          case 'e':
            blank   = !zero
            result += self.getDate();
            break;

          case 'j':
            result += self.$yday();
            break;

          case 'H':
            zero    = !blank;
            result += self.getHours();
            break;

          case 'k':
            blank   = !zero;
            result += self.getHours();
            break;

          case 'I':
            zero    = !blank;
            result += (self.getHours() % 12 || 12);
            break;

          case 'l':
            blank   = !zero;
            result += (self.getHours() % 12 || 12);
            break;

          case 'P':
            result += (self.getHours() >= 12 ? "pm" : "am");
            break;

          case 'p':
            result += (self.getHours() >= 12 ? "PM" : "AM");
            break;

          case 'M':
            zero    = !blank;
            result += self.getMinutes();
            break;

          case 'S':
            zero    = !blank;
            result += self.getSeconds();
            break;

          case 'L':
            zero    = !blank;
            width   = isNaN(width) ? 3 : width;
            result += self.getMilliseconds();
            break;

          case 'N':
            width   = isNaN(width) ? 9 : width;
            result += (self.getMilliseconds().toString()).$rjust(3, "0");
            result  = (result).$ljust(width, "0");
            break;

          case 'z':
            var offset  = self.getTimezoneOffset(),
                hours   = Math.floor(Math.abs(offset) / 60),
                minutes = Math.abs(offset) % 60;

            result += offset < 0 ? "+" : "-";
            result += hours < 10 ? "0" : "";
            result += hours;

            if (colons > 0) {
              result += ":";
            }

            result += minutes < 10 ? "0" : "";
            result += minutes;

            if (colons > 1) {
              result += ":00";
            }

            break;

          case 'Z':
            result += self.$zone();
            break;

          case 'A':
            result += days_of_week[self.getDay()];
            break;

          case 'a':
            result += short_days[self.getDay()];
            break;

          case 'u':
            result += (self.getDay() + 1);
            break;

          case 'w':
            result += self.getDay();
            break;

          // TODO: week year
          // TODO: week number

          case 's':
            result += parseInt(self.getTime() / 1000)
            break;

          case 'n':
            result += "\n";
            break;

          case 't':
            result += "\t";
            break;

          case '%':
            result += "%";
            break;

          case 'c':
            result += self.$strftime("%a %b %e %T %Y");
            break;

          case 'D':
          case 'x':
            result += self.$strftime("%m/%d/%y");
            break;

          case 'F':
            result += self.$strftime("%Y-%m-%d");
            break;

          case 'v':
            result += self.$strftime("%e-%^b-%4Y");
            break;

          case 'r':
            result += self.$strftime("%I:%M:%S %p");
            break;

          case 'R':
            result += self.$strftime("%H:%M");
            break;

          case 'T':
          case 'X':
            result += self.$strftime("%H:%M:%S");
            break;

          default:
            return full;
        }

        if (upcase) {
          result = result.toUpperCase();
        }

        if (invert) {
          result = result.replace(/[A-Z]/, function(c) { c.toLowerCase() }).
                          replace(/[a-z]/, function(c) { c.toUpperCase() });
        }

        if (pad && (zero || blank)) {
          result = (result).$rjust(isNaN(width) ? 2 : width, blank ? " " : "0");
        }

        return result;
      });
    
    };

    def['$sunday?'] = function() {
      var self = this;

      return self.getDay() === 0;
    };

    def['$thursday?'] = function() {
      var self = this;

      return self.getDay() === 4;
    };

    def.$to_a = function() {
      var self = this;

      return [self.$sec(), self.$min(), self.$hour(), self.$day(), self.$month(), self.$year(), self.$wday(), self.$yday(), self.$isdst(), self.$zone()];
    };

    def.$to_f = function() {
      var self = this;

      return self.getTime() / 1000;
    };

    def.$to_i = function() {
      var self = this;

      return parseInt(self.getTime() / 1000);
    };

    $opal.defn(self, '$to_s', def.$inspect);

    def['$tuesday?'] = function() {
      var self = this;

      return self.getDay() === 2;
    };

    $opal.defn(self, '$utc?', def['$gmt?']);

    def.$utc_offset = function() {
      var self = this;

      return self.getTimezoneOffset() * -60;
    };

    def.$wday = function() {
      var self = this;

      return self.getDay();
    };

    def['$wednesday?'] = function() {
      var self = this;

      return self.getDay() === 3;
    };

    return (def.$year = function() {
      var self = this;

      return self.getFullYear();
    }, nil) && 'year';
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/time.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$==', '$[]', '$upcase', '$const_set', '$new', '$unshift', '$each', '$define_struct_attribute', '$instance_eval', '$to_proc', '$raise', '$<<', '$members', '$define_method', '$instance_variable_get', '$instance_variable_set', '$include', '$each_with_index', '$class', '$===', '$>=', '$size', '$include?', '$to_sym', '$enum_for', '$hash', '$all?', '$length', '$map', '$+', '$name', '$join', '$inspect', '$each_pair']);
  return (function($base, $super) {
    function $Struct(){};
    var self = $Struct = $klass($base, $super, 'Struct', $Struct);

    var def = self._proto, $scope = self._scope, TMP_1, $a, TMP_8, TMP_10;

    $opal.defs(self, '$new', TMP_1 = function(name, args) {var $zuper = $slice.call(arguments, 0);
      var $a, $b, $c, TMP_2, $d, self = this, $iter = TMP_1._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_1._p = null;
      if (self['$==']((($a = $scope.Struct) == null ? $opal.cm('Struct') : $a))) {
        } else {
        return $opal.find_super_dispatcher(self, 'new', TMP_1, $iter, $Struct).apply(self, $zuper)
      };
      if (name['$[]'](0)['$=='](name['$[]'](0).$upcase())) {
        return (($a = $scope.Struct) == null ? $opal.cm('Struct') : $a).$const_set(name, ($a = self).$new.apply($a, [].concat(args)))
        } else {
        args.$unshift(name);
        return ($b = ($c = (($d = $scope.Class) == null ? $opal.cm('Class') : $d)).$new, $b._p = (TMP_2 = function(){var self = TMP_2._s || this, $a, $b, TMP_3, $c;

        ($a = ($b = args).$each, $a._p = (TMP_3 = function(arg){var self = TMP_3._s || this;
if (arg == null) arg = nil;
          return self.$define_struct_attribute(arg)}, TMP_3._s = self, TMP_3), $a).call($b);
          if (block !== false && block !== nil) {
            return ($a = ($c = self).$instance_eval, $a._p = block.$to_proc(), $a).call($c)
            } else {
            return nil
          };}, TMP_2._s = self, TMP_2), $b).call($c, self);
      };
    });

    $opal.defs(self, '$define_struct_attribute', function(name) {
      var $a, $b, TMP_4, $c, TMP_5, self = this;

      if (self['$==']((($a = $scope.Struct) == null ? $opal.cm('Struct') : $a))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "you cannot define attributes to the Struct class")};
      self.$members()['$<<'](name);
      ($a = ($b = self).$define_method, $a._p = (TMP_4 = function(){var self = TMP_4._s || this;

      return self.$instance_variable_get("@" + (name))}, TMP_4._s = self, TMP_4), $a).call($b, name);
      return ($a = ($c = self).$define_method, $a._p = (TMP_5 = function(value){var self = TMP_5._s || this;
if (value == null) value = nil;
      return self.$instance_variable_set("@" + (name), value)}, TMP_5._s = self, TMP_5), $a).call($c, "" + (name) + "=");
    });

    $opal.defs(self, '$members', function() {
      var $a, self = this;
      if (self.members == null) self.members = nil;

      if (self['$==']((($a = $scope.Struct) == null ? $opal.cm('Struct') : $a))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "the Struct class has no members")};
      return ((($a = self.members) !== false && $a !== nil) ? $a : self.members = []);
    });

    $opal.defs(self, '$inherited', function(klass) {
      var $a, $b, TMP_6, self = this, members = nil;
      if (self.members == null) self.members = nil;

      if (self['$==']((($a = $scope.Struct) == null ? $opal.cm('Struct') : $a))) {
        return nil};
      members = self.members;
      return ($a = ($b = klass).$instance_eval, $a._p = (TMP_6 = function(){var self = TMP_6._s || this;

      return self.members = members}, TMP_6._s = self, TMP_6), $a).call($b);
    });

    (function(self) {
      var $scope = self._scope, def = self._proto;

      return self._proto['$[]'] = self._proto.$new
    })(self.$singleton_class());

    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    def.$initialize = function(args) {
      var $a, $b, TMP_7, self = this;

      args = $slice.call(arguments, 0);
      return ($a = ($b = self.$members()).$each_with_index, $a._p = (TMP_7 = function(name, index){var self = TMP_7._s || this;
if (name == null) name = nil;if (index == null) index = nil;
      return self.$instance_variable_set("@" + (name), args['$[]'](index))}, TMP_7._s = self, TMP_7), $a).call($b);
    };

    def.$members = function() {
      var self = this;

      return self.$class().$members();
    };

    def['$[]'] = function(name) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](name)) !== nil && (!$a._isBoolean || $a == true))) {
        if (name['$>='](self.$members().$size())) {
          self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "offset " + (name) + " too large for struct(size:" + (self.$members().$size()) + ")")};
        name = self.$members()['$[]'](name);
      } else if ((($a = self.$members()['$include?'](name.$to_sym())) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "no member '" + (name) + "' in struct")
      };
      return self.$instance_variable_get("@" + (name));
    };

    def['$[]='] = function(name, value) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](name)) !== nil && (!$a._isBoolean || $a == true))) {
        if (name['$>='](self.$members().$size())) {
          self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "offset " + (name) + " too large for struct(size:" + (self.$members().$size()) + ")")};
        name = self.$members()['$[]'](name);
      } else if ((($a = self.$members()['$include?'](name.$to_sym())) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "no member '" + (name) + "' in struct")
      };
      return self.$instance_variable_set("@" + (name), value);
    };

    def.$each = TMP_8 = function() {
      var $a, $b, TMP_9, self = this, $iter = TMP_8._p, $yield = $iter || nil;

      TMP_8._p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      ($a = ($b = self.$members()).$each, $a._p = (TMP_9 = function(name){var self = TMP_9._s || this, $a;
if (name == null) name = nil;
      return $a = $opal.$yield1($yield, self['$[]'](name)), $a === $breaker ? $a : $a}, TMP_9._s = self, TMP_9), $a).call($b);
      return self;
    };

    def.$each_pair = TMP_10 = function() {
      var $a, $b, TMP_11, self = this, $iter = TMP_10._p, $yield = $iter || nil;

      TMP_10._p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("each_pair")
      };
      ($a = ($b = self.$members()).$each, $a._p = (TMP_11 = function(name){var self = TMP_11._s || this, $a;
if (name == null) name = nil;
      return $a = $opal.$yieldX($yield, [name, self['$[]'](name)]), $a === $breaker ? $a : $a}, TMP_11._s = self, TMP_11), $a).call($b);
      return self;
    };

    def['$eql?'] = function(other) {
      var $a, $b, $c, TMP_12, self = this;

      return ((($a = self.$hash()['$=='](other.$hash())) !== false && $a !== nil) ? $a : ($b = ($c = other.$each_with_index())['$all?'], $b._p = (TMP_12 = function(object, index){var self = TMP_12._s || this;
if (object == null) object = nil;if (index == null) index = nil;
      return self['$[]'](self.$members()['$[]'](index))['$=='](object)}, TMP_12._s = self, TMP_12), $b).call($c));
    };

    def.$length = function() {
      var self = this;

      return self.$members().$length();
    };

    $opal.defn(self, '$size', def.$length);

    def.$to_a = function() {
      var $a, $b, TMP_13, self = this;

      return ($a = ($b = self.$members()).$map, $a._p = (TMP_13 = function(name){var self = TMP_13._s || this;
if (name == null) name = nil;
      return self['$[]'](name)}, TMP_13._s = self, TMP_13), $a).call($b);
    };

    $opal.defn(self, '$values', def.$to_a);

    def.$inspect = function() {
      var $a, $b, TMP_14, self = this, result = nil;

      result = "#<struct ";
      if (self.$class()['$==']((($a = $scope.Struct) == null ? $opal.cm('Struct') : $a))) {
        result = result['$+']("" + (self.$class().$name()) + " ")};
      result = result['$+'](($a = ($b = self.$each_pair()).$map, $a._p = (TMP_14 = function(name, value){var self = TMP_14._s || this;
if (name == null) name = nil;if (value == null) value = nil;
      return "" + (name) + "=" + (value.$inspect())}, TMP_14._s = self, TMP_14), $a).call($b).$join(", "));
      result = result['$+'](">");
      return result;
    };

    return $opal.defn(self, '$to_s', def.$inspect);
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/struct.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, $b, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $module = $opal.module, $gvars = $opal.gvars;
  if ($gvars.stdout == null) $gvars.stdout = nil;
  if ($gvars.stderr == null) $gvars.stderr = nil;

  $opal.add_stubs(['$write', '$join', '$map', '$String', '$getbyte', '$getc', '$raise', '$new', '$to_s', '$extend']);
  (function($base, $super) {
    function $IO(){};
    var self = $IO = $klass($base, $super, 'IO', $IO);

    var def = self._proto, $scope = self._scope;

    $opal.cdecl($scope, 'SEEK_SET', 0);

    $opal.cdecl($scope, 'SEEK_CUR', 1);

    $opal.cdecl($scope, 'SEEK_END', 2);

    (function($base) {
      var self = $module($base, 'Writable');

      var def = self._proto, $scope = self._scope;

      def['$<<'] = function(string) {
        var self = this;

        self.$write(string);
        return self;
      };

      def.$print = function(args) {
        var $a, $b, TMP_1, self = this;
        if ($gvars[","] == null) $gvars[","] = nil;

        args = $slice.call(arguments, 0);
        return self.$write(($a = ($b = args).$map, $a._p = (TMP_1 = function(arg){var self = TMP_1._s || this;
if (arg == null) arg = nil;
        return self.$String(arg)}, TMP_1._s = self, TMP_1), $a).call($b).$join($gvars[","]));
      };

      def.$puts = function(args) {
        var $a, $b, TMP_2, self = this;
        if ($gvars["/"] == null) $gvars["/"] = nil;

        args = $slice.call(arguments, 0);
        return self.$write(($a = ($b = args).$map, $a._p = (TMP_2 = function(arg){var self = TMP_2._s || this;
if (arg == null) arg = nil;
        return self.$String(arg)}, TMP_2._s = self, TMP_2), $a).call($b).$join($gvars["/"]));
      };
            ;$opal.donate(self, ["$<<", "$print", "$puts"]);
    })(self);

    return (function($base) {
      var self = $module($base, 'Readable');

      var def = self._proto, $scope = self._scope;

      def.$readbyte = function() {
        var self = this;

        return self.$getbyte();
      };

      def.$readchar = function() {
        var self = this;

        return self.$getc();
      };

      def.$readline = function(sep) {
        var $a, self = this;
        if ($gvars["/"] == null) $gvars["/"] = nil;

        if (sep == null) {
          sep = $gvars["/"]
        }
        return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
      };

      def.$readpartial = function(integer, outbuf) {
        var $a, self = this;

        if (outbuf == null) {
          outbuf = nil
        }
        return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
      };
            ;$opal.donate(self, ["$readbyte", "$readchar", "$readline", "$readpartial"]);
    })(self);
  })(self, null);
  $opal.cdecl($scope, 'STDERR', $gvars.stderr = (($a = $scope.IO) == null ? $opal.cm('IO') : $a).$new());
  $opal.cdecl($scope, 'STDIN', $gvars.stdin = (($a = $scope.IO) == null ? $opal.cm('IO') : $a).$new());
  $opal.cdecl($scope, 'STDOUT', $gvars.stdout = (($a = $scope.IO) == null ? $opal.cm('IO') : $a).$new());
  $opal.defs($gvars.stdout, '$write', function(string) {
    var self = this;

    console.log(string.$to_s());;
    return nil;
  });
  $opal.defs($gvars.stderr, '$write', function(string) {
    var self = this;

    console.warn(string.$to_s());;
    return nil;
  });
  $gvars.stdout.$extend((($a = ((($b = $scope.IO) == null ? $opal.cm('IO') : $b))._scope).Writable == null ? $a.cm('Writable') : $a.Writable));
  return $gvars.stderr.$extend((($a = ((($b = $scope.IO) == null ? $opal.cm('IO') : $b))._scope).Writable == null ? $a.cm('Writable') : $a.Writable));
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/io.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice;

  $opal.add_stubs(['$include']);
  $opal.defs(self, '$to_s', function() {
    var self = this;

    return "main";
  });
  return ($opal.defs(self, '$include', function(mod) {
    var $a, self = this;

    return (($a = $scope.Object) == null ? $opal.cm('Object') : $a).$include(mod);
  }), nil) && 'include';
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/main.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $gvars = $opal.gvars, $hash2 = $opal.hash2;

  $opal.add_stubs(['$new']);
  $gvars["&"] = $gvars["~"] = $gvars["`"] = $gvars["'"] = nil;
  $gvars[":"] = [];
  $gvars["\""] = [];
  $gvars["/"] = "\n";
  $gvars[","] = nil;
  $opal.cdecl($scope, 'ARGV', []);
  $opal.cdecl($scope, 'ARGF', (($a = $scope.Object) == null ? $opal.cm('Object') : $a).$new());
  $opal.cdecl($scope, 'ENV', $hash2([], {}));
  $gvars.VERBOSE = false;
  $gvars.DEBUG = false;
  $gvars.SAFE = 0;
  $opal.cdecl($scope, 'RUBY_PLATFORM', "opal");
  $opal.cdecl($scope, 'RUBY_ENGINE', "opal");
  $opal.cdecl($scope, 'RUBY_VERSION', "2.1.1");
  $opal.cdecl($scope, 'RUBY_ENGINE_VERSION', "0.6.1");
  return $opal.cdecl($scope, 'RUBY_RELEASE_DATE', "2014-04-15");
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/corelib/variables.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice;

  $opal.add_stubs([]);
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  return true;
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/opal.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $range = $opal.range, $hash2 = $opal.hash2, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$try_convert', '$native?', '$respond_to?', '$to_n', '$raise', '$inspect', '$Native', '$end_with?', '$define_method', '$[]', '$convert', '$call', '$to_proc', '$new', '$each', '$native_reader', '$native_writer', '$extend', '$to_a', '$to_ary', '$include', '$method_missing', '$bind', '$instance_method', '$[]=', '$slice', '$-', '$length', '$enum_for', '$===', '$>=', '$<<', '$==', '$instance_variable_set', '$members', '$each_with_index', '$each_pair', '$name']);
  (function($base) {
    var self = $module($base, 'Native');

    var def = self._proto, $scope = self._scope, TMP_1;

    $opal.defs(self, '$is_a?', function(object, klass) {
      var self = this;

      
      try {
        return object instanceof self.$try_convert(klass);
      }
      catch (e) {
        return false;
      }
    ;
    });

    $opal.defs(self, '$try_convert', function(value) {
      var self = this;

      
      if (self['$native?'](value)) {
        return value;
      }
      else if (value['$respond_to?']("to_n")) {
        return value.$to_n();
      }
      else {
        return nil;
      }
    ;
    });

    $opal.defs(self, '$convert', function(value) {
      var $a, self = this;

      
      if (self['$native?'](value)) {
        return value;
      }
      else if (value['$respond_to?']("to_n")) {
        return value.$to_n();
      }
      else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "" + (value.$inspect()) + " isn't native");
      }
    ;
    });

    $opal.defs(self, '$call', TMP_1 = function(obj, key, args) {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      args = $slice.call(arguments, 2);
      TMP_1._p = null;
      
      var prop = obj[key];

      if (prop instanceof Function) {
        var converted = new Array(args.length);

        for (var i = 0, length = args.length; i < length; i++) {
          var item = args[i],
              conv = self.$try_convert(item);

          converted[i] = conv === nil ? item : conv;
        }

        if (block !== nil) {
          converted.push(block);
        }

        return self.$Native(prop.apply(obj, converted));
      }
      else {
        return self.$Native(prop);
      }
    ;
    });

    (function($base) {
      var self = $module($base, 'Helpers');

      var def = self._proto, $scope = self._scope;

      def.$alias_native = function(new$, old, options) {
        var $a, $b, TMP_2, $c, TMP_3, $d, TMP_4, self = this, as = nil;

        if (old == null) {
          old = new$
        }
        if (options == null) {
          options = $hash2([], {})
        }
        if ((($a = old['$end_with?']("=")) !== nil && (!$a._isBoolean || $a == true))) {
          return ($a = ($b = self).$define_method, $a._p = (TMP_2 = function(value){var self = TMP_2._s || this, $a;
            if (self["native"] == null) self["native"] = nil;
if (value == null) value = nil;
          self["native"][old['$[]']($range(0, -2, false))] = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(value);
            return value;}, TMP_2._s = self, TMP_2), $a).call($b, new$)
        } else if ((($a = as = options['$[]']("as")) !== nil && (!$a._isBoolean || $a == true))) {
          return ($a = ($c = self).$define_method, $a._p = (TMP_3 = function(args){var self = TMP_3._s || this, block, $a, $b, $c, $d;
            if (self["native"] == null) self["native"] = nil;
args = $slice.call(arguments, 0);
            block = TMP_3._p || nil, TMP_3._p = null;
          if ((($a = value = ($b = ($c = (($d = $scope.Native) == null ? $opal.cm('Native') : $d)).$call, $b._p = block.$to_proc(), $b).apply($c, [self["native"], old].concat(args))) !== nil && (!$a._isBoolean || $a == true))) {
              return as.$new(value.$to_n())
              } else {
              return nil
            }}, TMP_3._s = self, TMP_3), $a).call($c, new$)
          } else {
          return ($a = ($d = self).$define_method, $a._p = (TMP_4 = function(args){var self = TMP_4._s || this, block, $a, $b, $c;
            if (self["native"] == null) self["native"] = nil;
args = $slice.call(arguments, 0);
            block = TMP_4._p || nil, TMP_4._p = null;
          return ($a = ($b = (($c = $scope.Native) == null ? $opal.cm('Native') : $c)).$call, $a._p = block.$to_proc(), $a).apply($b, [self["native"], old].concat(args))}, TMP_4._s = self, TMP_4), $a).call($d, new$)
        };
      };

      def.$native_reader = function(names) {
        var $a, $b, TMP_5, self = this;

        names = $slice.call(arguments, 0);
        return ($a = ($b = names).$each, $a._p = (TMP_5 = function(name){var self = TMP_5._s || this, $a, $b, TMP_6;
if (name == null) name = nil;
        return ($a = ($b = self).$define_method, $a._p = (TMP_6 = function(){var self = TMP_6._s || this;
            if (self["native"] == null) self["native"] = nil;

          return self.$Native(self["native"][name])}, TMP_6._s = self, TMP_6), $a).call($b, name)}, TMP_5._s = self, TMP_5), $a).call($b);
      };

      def.$native_writer = function(names) {
        var $a, $b, TMP_7, self = this;

        names = $slice.call(arguments, 0);
        return ($a = ($b = names).$each, $a._p = (TMP_7 = function(name){var self = TMP_7._s || this, $a, $b, TMP_8;
if (name == null) name = nil;
        return ($a = ($b = self).$define_method, $a._p = (TMP_8 = function(value){var self = TMP_8._s || this;
            if (self["native"] == null) self["native"] = nil;
if (value == null) value = nil;
          return self.$Native(self["native"][name] = value)}, TMP_8._s = self, TMP_8), $a).call($b, "" + (name) + "=")}, TMP_7._s = self, TMP_7), $a).call($b);
      };

      def.$native_accessor = function(names) {
        var $a, $b, self = this;

        names = $slice.call(arguments, 0);
        ($a = self).$native_reader.apply($a, [].concat(names));
        return ($b = self).$native_writer.apply($b, [].concat(names));
      };
            ;$opal.donate(self, ["$alias_native", "$native_reader", "$native_writer", "$native_accessor"]);
    })(self);

    $opal.defs(self, '$included', function(klass) {
      var $a, self = this;

      return klass.$extend((($a = $scope.Helpers) == null ? $opal.cm('Helpers') : $a));
    });

    def.$initialize = function(native$) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Kernel) == null ? $opal.cm('Kernel') : $b)['$native?'](native$)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        (($a = $scope.Kernel) == null ? $opal.cm('Kernel') : $a).$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "" + (native$.$inspect()) + " isn't native")
      };
      return self["native"] = native$;
    };

    def.$to_n = function() {
      var self = this;
      if (self["native"] == null) self["native"] = nil;

      return self["native"];
    };
        ;$opal.donate(self, ["$initialize", "$to_n"]);
  })(self);
  (function($base) {
    var self = $module($base, 'Kernel');

    var def = self._proto, $scope = self._scope, TMP_9;

    def['$native?'] = function(value) {
      var self = this;

      return value == null || !value._klass;
    };

    def.$Native = function(obj) {
      var $a, $b, self = this;

      if ((($a = obj == null) !== nil && (!$a._isBoolean || $a == true))) {
        return nil
      } else if ((($a = self['$native?'](obj)) !== nil && (!$a._isBoolean || $a == true))) {
        return (($a = ((($b = $scope.Native) == null ? $opal.cm('Native') : $b))._scope).Object == null ? $a.cm('Object') : $a.Object).$new(obj)
        } else {
        return obj
      };
    };

    def.$Array = TMP_9 = function(object, args) {
      var $a, $b, $c, $d, self = this, $iter = TMP_9._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_9._p = null;
      
      if (object == null || object === nil) {
        return [];
      }
      else if (self['$native?'](object)) {
        return ($a = ($b = (($c = ((($d = $scope.Native) == null ? $opal.cm('Native') : $d))._scope).Array == null ? $c.cm('Array') : $c.Array)).$new, $a._p = block.$to_proc(), $a).apply($b, [object].concat(args)).$to_a();
      }
      else if (object['$respond_to?']("to_ary")) {
        return object.$to_ary();
      }
      else if (object['$respond_to?']("to_a")) {
        return object.$to_a();
      }
      else {
        return [object];
      }
    ;
    };
        ;$opal.donate(self, ["$native?", "$Native", "$Array"]);
  })(self);
  (function($base, $super) {
    function $Object(){};
    var self = $Object = $klass($base, $super, 'Object', $Object);

    var def = self._proto, $scope = self._scope, $a, TMP_10, TMP_11, TMP_12;

    def["native"] = nil;
    self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

    $opal.defn(self, '$==', function(other) {
      var $a, self = this;

      return self["native"] === (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$try_convert(other);
    });

    $opal.defn(self, '$has_key?', function(name) {
      var self = this;

      return $opal.hasOwnProperty.call(self["native"], name);
    });

    $opal.defn(self, '$key?', def['$has_key?']);

    $opal.defn(self, '$include?', def['$has_key?']);

    $opal.defn(self, '$member?', def['$has_key?']);

    $opal.defn(self, '$each', TMP_10 = function(args) {
      var $a, self = this, $iter = TMP_10._p, $yield = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_10._p = null;
      if (($yield !== nil)) {
        
        for (var key in self["native"]) {
          ((($a = $opal.$yieldX($yield, [key, self["native"][key]])) === $breaker) ? $breaker.$v : $a)
        }
      ;
        return self;
        } else {
        return ($a = self).$method_missing.apply($a, ["each"].concat(args))
      };
    });

    $opal.defn(self, '$[]', function(key) {
      var $a, self = this;

      
      var prop = self["native"][key];

      if (prop instanceof Function) {
        return prop;
      }
      else {
        return (($a = $opal.Object._scope.Native) == null ? $opal.cm('Native') : $a).$call(self["native"], key)
      }
    ;
    });

    $opal.defn(self, '$[]=', function(key, value) {
      var $a, self = this, native$ = nil;

      native$ = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$try_convert(value);
      if ((($a = native$ === nil) !== nil && (!$a._isBoolean || $a == true))) {
        return self["native"][key] = value;
        } else {
        return self["native"][key] = native$;
      };
    });

    $opal.defn(self, '$merge!', function(other) {
      var $a, self = this;

      
      var other = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(other);

      for (var prop in other) {
        self["native"][prop] = other[prop];
      }
    ;
      return self;
    });

    $opal.defn(self, '$respond_to?', function(name, include_all) {
      var $a, self = this;

      if (include_all == null) {
        include_all = false
      }
      return (($a = $scope.Kernel) == null ? $opal.cm('Kernel') : $a).$instance_method("respond_to?").$bind(self).$call(name, include_all);
    });

    $opal.defn(self, '$respond_to_missing?', function(name) {
      var self = this;

      return $opal.hasOwnProperty.call(self["native"], name);
    });

    $opal.defn(self, '$method_missing', TMP_11 = function(mid, args) {
      var $a, $b, $c, self = this, $iter = TMP_11._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_11._p = null;
      
      if (mid.charAt(mid.length - 1) === '=') {
        return self['$[]='](mid.$slice(0, mid.$length()['$-'](1)), args['$[]'](0));
      }
      else {
        return ($a = ($b = (($c = $opal.Object._scope.Native) == null ? $opal.cm('Native') : $c)).$call, $a._p = block.$to_proc(), $a).apply($b, [self["native"], mid].concat(args));
      }
    ;
    });

    $opal.defn(self, '$nil?', function() {
      var self = this;

      return false;
    });

    $opal.defn(self, '$is_a?', function(klass) {
      var self = this;

      return $opal.is_a(self, klass);
    });

    $opal.defn(self, '$kind_of?', def['$is_a?']);

    $opal.defn(self, '$instance_of?', function(klass) {
      var self = this;

      return self._klass === klass;
    });

    $opal.defn(self, '$class', function() {
      var self = this;

      return self._klass;
    });

    $opal.defn(self, '$to_a', TMP_12 = function(options) {
      var $a, $b, $c, $d, self = this, $iter = TMP_12._p, block = $iter || nil;

      if (options == null) {
        options = $hash2([], {})
      }
      TMP_12._p = null;
      return ($a = ($b = (($c = ((($d = $scope.Native) == null ? $opal.cm('Native') : $d))._scope).Array == null ? $c.cm('Array') : $c.Array)).$new, $a._p = block.$to_proc(), $a).call($b, self["native"], options).$to_a();
    });

    return ($opal.defn(self, '$inspect', function() {
      var self = this;

      return "#<Native:" + (String(self["native"])) + ">";
    }), nil) && 'inspect';
  })((($a = $scope.Native) == null ? $opal.cm('Native') : $a), (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a));
  (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self._proto, $scope = self._scope, $a, TMP_13, TMP_14;

    def.named = def["native"] = def.get = def.block = def.set = def.length = nil;
    self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    def.$initialize = TMP_13 = function(native$, options) {
      var $a, self = this, $iter = TMP_13._p, block = $iter || nil;

      if (options == null) {
        options = $hash2([], {})
      }
      TMP_13._p = null;
      $opal.find_super_dispatcher(self, 'initialize', TMP_13, null).apply(self, [native$]);
      self.get = ((($a = options['$[]']("get")) !== false && $a !== nil) ? $a : options['$[]']("access"));
      self.named = options['$[]']("named");
      self.set = ((($a = options['$[]']("set")) !== false && $a !== nil) ? $a : options['$[]']("access"));
      self.length = ((($a = options['$[]']("length")) !== false && $a !== nil) ? $a : "length");
      self.block = block;
      if ((($a = self.$length() == null) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no length found on the array-like object")
        } else {
        return nil
      };
    };

    def.$each = TMP_14 = function() {
      var self = this, $iter = TMP_14._p, block = $iter || nil;

      TMP_14._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each")
      };
      
      for (var i = 0, length = self.$length(); i < length; i++) {
        var value = $opal.$yield1(block, self['$[]'](i));

        if (value === $breaker) {
          return $breaker.$v;
        }
      }
    ;
      return self;
    };

    def['$[]'] = function(index) {
      var $a, self = this, result = nil, $case = nil;

      result = (function() {$case = index;if ((($a = $scope.String) == null ? $opal.cm('String') : $a)['$===']($case) || (($a = $scope.Symbol) == null ? $opal.cm('Symbol') : $a)['$===']($case)) {if ((($a = self.named) !== nil && (!$a._isBoolean || $a == true))) {
        return self["native"][self.named](index);
        } else {
        return self["native"][index];
      }}else if ((($a = $scope.Integer) == null ? $opal.cm('Integer') : $a)['$===']($case)) {if ((($a = self.get) !== nil && (!$a._isBoolean || $a == true))) {
        return self["native"][self.get](index);
        } else {
        return self["native"][index];
      }}else { return nil }})();
      if (result !== false && result !== nil) {
        if ((($a = self.block) !== nil && (!$a._isBoolean || $a == true))) {
          return self.block.$call(result)
          } else {
          return self.$Native(result)
        }
        } else {
        return nil
      };
    };

    def['$[]='] = function(index, value) {
      var $a, self = this;

      if ((($a = self.set) !== nil && (!$a._isBoolean || $a == true))) {
        return self["native"][self.set](index, (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(value));
        } else {
        return self["native"][index] = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(value);
      };
    };

    def.$last = function(count) {
      var $a, self = this, index = nil, result = nil;

      if (count == null) {
        count = nil
      }
      if (count !== false && count !== nil) {
        index = self.$length()['$-'](1);
        result = [];
        while (index['$>='](0)) {
        result['$<<'](self['$[]'](index));
        index = index['$-'](1);};
        return result;
        } else {
        return self['$[]'](self.$length()['$-'](1))
      };
    };

    def.$length = function() {
      var self = this;

      return self["native"][self.length];
    };

    $opal.defn(self, '$to_ary', def.$to_a);

    return (def.$inspect = function() {
      var self = this;

      return self.$to_a().$inspect();
    }, nil) && 'inspect';
  })((($a = $scope.Native) == null ? $opal.cm('Native') : $a), null);
  (function($base, $super) {
    function $Numeric(){};
    var self = $Numeric = $klass($base, $super, 'Numeric', $Numeric);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return self.valueOf();
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Proc(){};
    var self = $Proc = $klass($base, $super, 'Proc', $Proc);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return self;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return self.valueOf();
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Regexp(){};
    var self = $Regexp = $klass($base, $super, 'Regexp', $Regexp);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return self.valueOf();
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $MatchData(){};
    var self = $MatchData = $klass($base, $super, 'MatchData', $MatchData);

    var def = self._proto, $scope = self._scope;

    def.matches = nil;
    return (def.$to_n = function() {
      var self = this;

      return self.matches;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Struct(){};
    var self = $Struct = $klass($base, $super, 'Struct', $Struct);

    var def = self._proto, $scope = self._scope;

    def.$initialize = function(args) {
      var $a, $b, TMP_15, $c, TMP_16, self = this, object = nil;

      args = $slice.call(arguments, 0);
      if ((($a = (($b = args.$length()['$=='](1)) ? self['$native?'](args['$[]'](0)) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        object = args['$[]'](0);
        return ($a = ($b = self.$members()).$each, $a._p = (TMP_15 = function(name){var self = TMP_15._s || this;
if (name == null) name = nil;
        return self.$instance_variable_set("@" + (name), self.$Native(object[name]))}, TMP_15._s = self, TMP_15), $a).call($b);
        } else {
        return ($a = ($c = self.$members()).$each_with_index, $a._p = (TMP_16 = function(name, index){var self = TMP_16._s || this;
if (name == null) name = nil;if (index == null) index = nil;
        return self.$instance_variable_set("@" + (name), args['$[]'](index))}, TMP_16._s = self, TMP_16), $a).call($c)
      };
    };

    return (def.$to_n = function() {
      var $a, $b, TMP_17, self = this, result = nil;

      result = {};
      ($a = ($b = self).$each_pair, $a._p = (TMP_17 = function(name, value){var self = TMP_17._s || this;
if (name == null) name = nil;if (value == null) value = nil;
      return result[name] = value.$to_n();}, TMP_17._s = self, TMP_17), $a).call($b);
      return result;
    }, nil) && 'to_n';
  })(self, null);
  (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var obj = self[i];

        if ((obj)['$respond_to?']("to_n")) {
          result.push((obj).$to_n());
        }
        else {
          result.push(obj);
        }
      }

      return result;
    ;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Boolean(){};
    var self = $Boolean = $klass($base, $super, 'Boolean', $Boolean);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return self.valueOf();
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Time(){};
    var self = $Time = $klass($base, $super, 'Time', $Time);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return self;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $NilClass(){};
    var self = $NilClass = $klass($base, $super, 'NilClass', $NilClass);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return null;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Hash(){};
    var self = $Hash = $klass($base, $super, 'Hash', $Hash);

    var def = self._proto, $scope = self._scope, TMP_18;

    def.$initialize = TMP_18 = function(defaults) {
      var $a, self = this, $iter = TMP_18._p, block = $iter || nil;

      TMP_18._p = null;
      
      if (defaults != null) {
        if (defaults.constructor === Object) {
          var map  = self.map,
              keys = self.keys;

          for (var key in defaults) {
            var value = defaults[key];

            if (value && value.constructor === Object) {
              map[key] = (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a).$new(value);
            }
            else {
              map[key] = self.$Native(defaults[key]);
            }

            keys.push(key);
          }
        }
        else {
          self.none = defaults;
        }
      }
      else if (block !== nil) {
        self.proc = block;
      }

      return self;
    
    };

    return (def.$to_n = function() {
      var self = this;

      
      var result = {},
          keys   = self.keys,
          map    = self.map,
          bucket,
          value;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i],
            obj = map[key];

        if ((obj)['$respond_to?']("to_n")) {
          result[key] = (obj).$to_n();
        }
        else {
          result[key] = obj;
        }
      }

      return result;
    ;
    }, nil) && 'to_n';
  })(self, null);
  (function($base, $super) {
    function $Module(){};
    var self = $Module = $klass($base, $super, 'Module', $Module);

    var def = self._proto, $scope = self._scope;

    return (def.$native_module = function() {
      var self = this;

      return Opal.global[self.$name()] = self;
    }, nil) && 'native_module'
  })(self, null);
  (function($base, $super) {
    function $Class(){};
    var self = $Class = $klass($base, $super, 'Class', $Class);

    var def = self._proto, $scope = self._scope;

    def.$native_alias = function(jsid, mid) {
      var self = this;

      return self._proto[jsid] = self._proto['$' + mid];
    };

    return $opal.defn(self, '$native_class', def.$native_module);
  })(self, null);
  return $gvars.$ = $gvars.global = self.$Native(Opal.global);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/native.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $module = $opal.module;

  $opal.add_stubs(['$size', '$min', '$scan', '$gsub', '$proc', '$===', '$merge', '$to_proc', '$merge!']);
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope;

    return (function($base) {
      var self = $module($base, 'Utils');

      var def = self._proto, $scope = self._scope;

      $opal.defs(self, '$heredoc', function(string) {
        var self = this, indent = nil;

        indent = (function() {try {return string.$scan(/^[ \t]*(?=\S)/).$min().$size() } catch ($err) { return 0 }})();
        return string.$gsub((new RegExp("^[ \\t]{" + indent + "}")), "");
      });

      $opal.defs(self, '$deep_merge', function(a, b) {
        var $a, $b, TMP_1, $c, self = this, merger = nil;

        merger = ($a = ($b = self).$proc, $a._p = (TMP_1 = function(key, v1, v2){var self = TMP_1._s || this, $a, $b, $c;
if (key == null) key = nil;if (v1 == null) v1 = nil;if (v2 == null) v2 = nil;
        if ((($a = ($b = (($c = $scope.Hash) == null ? $opal.cm('Hash') : $c)['$==='](v1), $b !== false && $b !== nil ?(($c = $scope.Hash) == null ? $opal.cm('Hash') : $c)['$==='](v2) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            return ($a = ($b = v1).$merge, $a._p = merger.$to_proc(), $a).call($b, v2)
            } else {
            return v2
          }}, TMP_1._s = self, TMP_1), $a).call($b);
        return ($a = ($c = a).$merge, $a._p = merger.$to_proc(), $a).call($c, b);
      });

      $opal.defs(self, '$deep_merge!', function(a, b) {
        var $a, $b, TMP_2, $c, self = this, merger = nil;

        merger = ($a = ($b = self).$proc, $a._p = (TMP_2 = function(key, v1, v2){var self = TMP_2._s || this, $a, $b, $c;
if (key == null) key = nil;if (v1 == null) v1 = nil;if (v2 == null) v2 = nil;
        if ((($a = ($b = (($c = $scope.Hash) == null ? $opal.cm('Hash') : $c)['$==='](v1), $b !== false && $b !== nil ?(($c = $scope.Hash) == null ? $opal.cm('Hash') : $c)['$==='](v2) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            ($a = ($b = v1)['$merge!'], $a._p = merger.$to_proc(), $a).call($b, v2);
            return v1;
            } else {
            return v2
          }}, TMP_2._s = self, TMP_2), $a).call($b);
        return ($a = ($c = a)['$merge!'], $a._p = merger.$to_proc(), $a).call($c, b);
      });
      
    })(self)
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/utils.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$define_method', '$instance_exec', '$to_proc', '$do', '$defhelper', '$[]=']);
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $HTML(){};
      var self = $HTML = $klass($base, $super, 'HTML', $HTML);

      var def = self._proto, $scope = self._scope, $a;

      return (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope, TMP_1;

        $opal.defs(self, '$defhelper', TMP_1 = function(name) {
          var $a, $b, TMP_2, self = this, $iter = TMP_1._p, block = $iter || nil;

          TMP_1._p = null;
          return ($a = ($b = self).$define_method, $a._p = (TMP_2 = function(args){var self = TMP_2._s || this, body, $a, $b, $c;
args = $slice.call(arguments, 0);
            body = TMP_2._p || nil, TMP_2._p = null;
          ($a = ($b = self).$instance_exec, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
            if (body !== false && body !== nil) {
              ($a = ($c = self).$do, $a._p = body.$to_proc(), $a).call($c)};
            return self;}, TMP_2._s = self, TMP_2), $a).call($b, name);
        });

        return ($opal.defs(self, '$defhelper!', function(name, attribute) {
          var $a, $b, TMP_3, self = this;

          if (attribute == null) {
            attribute = name
          }
          return ($a = ($b = self).$defhelper, $a._p = (TMP_3 = function(){var self = TMP_3._s || this;
            if (self.attributes == null) self.attributes = nil;

          return self.attributes['$[]='](attribute, true)}, TMP_3._s = self, TMP_3), $a).call($b, "" + (name) + "!");
        }), nil) && 'defhelper!';
      })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/html/helpers.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$each', '$defhelper', '$[]=', '$to_s', '$defhelper!', '$<<']);
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $HTML(){};
      var self = $HTML = $klass($base, $super, 'HTML', $HTML);

      var def = self._proto, $scope = self._scope, $a;

      return (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope;

        return (function($base, $super) {
          function $A(){};
          var self = $A = $klass($base, $super, 'A', $A);

          var def = self._proto, $scope = self._scope, $a, $b, TMP_1, $c, TMP_3;

          ($a = ($b = $hash2(["href", "url", "rel", "relative", "target", "type", "lang", "language", "media"], {"href": "href", "url": "href", "rel": "rel", "relative": "rel", "target": "target", "type": "type", "lang": "hreflang", "language": "hreflang", "media": "media"})).$each, $a._p = (TMP_1 = function(name, attribute){var self = TMP_1._s || this, $a, $b, TMP_2;
if (name == null) name = nil;if (attribute == null) attribute = nil;
          return ($a = ($b = self).$defhelper, $a._p = (TMP_2 = function(value){var self = TMP_2._s || this;
              if (self.attributes == null) self.attributes = nil;
if (value == null) value = nil;
            return self.attributes['$[]='](attribute, value.$to_s())}, TMP_2._s = self, TMP_2), $a).call($b, name)}, TMP_1._s = self, TMP_1), $a).call($b);

          self['$defhelper!']("download");

          self['$defhelper!']("ping");

          return ($a = ($c = self).$defhelper, $a._p = (TMP_3 = function(string){var self = TMP_3._s || this;
if (string == null) string = nil;
          return self['$<<'](string)}, TMP_3._s = self, TMP_3), $a).call($c, "text");
        })(self, self)
      })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/html/element/a.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$each', '$defhelper', '$[]=', '$to_s']);
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $HTML(){};
      var self = $HTML = $klass($base, $super, 'HTML', $HTML);

      var def = self._proto, $scope = self._scope, $a;

      return (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope;

        return (function($base, $super) {
          function $Base(){};
          var self = $Base = $klass($base, $super, 'Base', $Base);

          var def = self._proto, $scope = self._scope, $a, $b, TMP_1;

          return ($a = ($b = $hash2(["href", "url", "target"], {"href": "href", "url": "href", "target": "target"})).$each, $a._p = (TMP_1 = function(name, attribute){var self = TMP_1._s || this, $a, $b, TMP_2;
if (name == null) name = nil;if (attribute == null) attribute = nil;
          return ($a = ($b = self).$defhelper, $a._p = (TMP_2 = function(value){var self = TMP_2._s || this;
              if (self.attributes == null) self.attributes = nil;
if (value == null) value = nil;
            return self.attributes['$[]='](attribute, value.$to_s())}, TMP_2._s = self, TMP_2), $a).call($b, name)}, TMP_1._s = self, TMP_1), $a).call($b)
        })(self, self)
      })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/html/element/base.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$defhelper', '$[]=', '$to_s']);
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $HTML(){};
      var self = $HTML = $klass($base, $super, 'HTML', $HTML);

      var def = self._proto, $scope = self._scope, $a;

      return (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope;

        return (function($base, $super) {
          function $Blockquote(){};
          var self = $Blockquote = $klass($base, $super, 'Blockquote', $Blockquote);

          var def = self._proto, $scope = self._scope, $a, $b, TMP_1;

          return ($a = ($b = self).$defhelper, $a._p = (TMP_1 = function(value){var self = TMP_1._s || this;
            if (self.attributes == null) self.attributes = nil;
if (value == null) value = nil;
          return self.attributes['$[]=']("cite", value.$to_s())}, TMP_1._s = self, TMP_1), $a).call($b, "cite")
        })(self, self)
      })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/html/element/blockquote.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$each', '$defhelper', '$[]=', '$attribute', '$to_s', '$defhelper!']);
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $HTML(){};
      var self = $HTML = $klass($base, $super, 'HTML', $HTML);

      var def = self._proto, $scope = self._scope, $a;

      return (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope;

        return (function($base, $super) {
          function $Button(){};
          var self = $Button = $klass($base, $super, 'Button', $Button);

          var def = self._proto, $scope = self._scope, $a, $b, TMP_1;

          ($a = ($b = $hash2(["form", "name", "type", "value", "action", "encoding", "method", "target"], {"form": "form", "name": "name", "type": "type", "value": "value", "action": "formaction", "encoding": "formenctype", "method": "formmethod", "target": "formtarget"})).$each, $a._p = (TMP_1 = function(name, attributes){var self = TMP_1._s || this, $a, $b, TMP_2;
if (name == null) name = nil;if (attributes == null) attributes = nil;
          return ($a = ($b = self).$defhelper, $a._p = (TMP_2 = function(value){var self = TMP_2._s || this;
              if (self.attributes == null) self.attributes = nil;
if (value == null) value = nil;
            return self.attributes['$[]='](self.$attribute(), value.$to_s())}, TMP_2._s = self, TMP_2), $a).call($b, name)}, TMP_1._s = self, TMP_1), $a).call($b);

          self['$defhelper!']("autofocus");

          return self['$defhelper!']("disabled");
        })(self, self)
      })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/html/element/button.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$each', '$defhelper', '$[]=', '$to_s']);
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $HTML(){};
      var self = $HTML = $klass($base, $super, 'HTML', $HTML);

      var def = self._proto, $scope = self._scope, $a;

      return (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope;

        return (function($base, $super) {
          function $Canvas(){};
          var self = $Canvas = $klass($base, $super, 'Canvas', $Canvas);

          var def = self._proto, $scope = self._scope, $a, $b, TMP_1;

          return ($a = ($b = $hash2(["width", "height"], {"width": "width", "height": "height"})).$each, $a._p = (TMP_1 = function(name, attribute){var self = TMP_1._s || this, $a, $b, TMP_2;
if (name == null) name = nil;if (attribute == null) attribute = nil;
          return ($a = ($b = self).$defhelper, $a._p = (TMP_2 = function(value){var self = TMP_2._s || this;
              if (self.attributes == null) self.attributes = nil;
if (value == null) value = nil;
            return self.attributes['$[]='](attribute, value.$to_s())}, TMP_2._s = self, TMP_2), $a).call($b, name)}, TMP_1._s = self, TMP_1), $a).call($b)
        })(self, self)
      })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/html/element/canvas.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$each', '$defhelper', '$[]=', '$to_s']);
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $HTML(){};
      var self = $HTML = $klass($base, $super, 'HTML', $HTML);

      var def = self._proto, $scope = self._scope, $a;

      return (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope;

        return (function($base, $super) {
          function $Img(){};
          var self = $Img = $klass($base, $super, 'Img', $Img);

          var def = self._proto, $scope = self._scope, $a, $b, TMP_1, $c, TMP_3;

          ($a = ($b = $hash2(["src", "url", "alt", "description", "height", "width", "map"], {"src": "src", "url": "src", "alt": "alt", "description": "alt", "height": "height", "width": "width", "map": "usemap"})).$each, $a._p = (TMP_1 = function(name, attribute){var self = TMP_1._s || this, $a, $b, TMP_2;
if (name == null) name = nil;if (attribute == null) attribute = nil;
          return ($a = ($b = self).$defhelper, $a._p = (TMP_2 = function(value){var self = TMP_2._s || this;
              if (self.attributes == null) self.attributes = nil;
if (value == null) value = nil;
            return self.attributes['$[]='](attribute, value.$to_s())}, TMP_2._s = self, TMP_2), $a).call($b, name)}, TMP_1._s = self, TMP_1), $a).call($b);

          return ($a = ($c = self).$defhelper, $a._p = (TMP_3 = function(){var self = TMP_3._s || this;
            if (self.attributes == null) self.attributes = nil;

          return self.attributes['$[]=']("ismap", true)}, TMP_3._s = self, TMP_3), $a).call($c, "map!");
        })(self, self)
      })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/html/element/img.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$each', '$defhelper', '$[]=']);
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $HTML(){};
      var self = $HTML = $klass($base, $super, 'HTML', $HTML);

      var def = self._proto, $scope = self._scope, $a;

      return (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope;

        return (function($base, $super) {
          function $Input(){};
          var self = $Input = $klass($base, $super, 'Input', $Input);

          var def = self._proto, $scope = self._scope, $a, $b, TMP_1;

          return ($a = ($b = $hash2(["type", "name", "value", "size", "place_holder", "read_only", "required"], {"type": "type", "name": "name", "value": "value", "size": "size", "place_holder": "placeholder", "read_only": "readonly", "required": "required"})).$each, $a._p = (TMP_1 = function(name, attribute){var self = TMP_1._s || this, $a, $b, TMP_2;
if (name == null) name = nil;if (attribute == null) attribute = nil;
          return ($a = ($b = self).$defhelper, $a._p = (TMP_2 = function(value){var self = TMP_2._s || this;
              if (self.attributes == null) self.attributes = nil;
if (value == null) value = nil;
            return self.attributes['$[]='](attribute, value)}, TMP_2._s = self, TMP_2), $a).call($b, name)}, TMP_1._s = self, TMP_1), $a).call($b)
        })(self, self)
      })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/html/element/input.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$each', '$defhelper', '$[]=']);
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $HTML(){};
      var self = $HTML = $klass($base, $super, 'HTML', $HTML);

      var def = self._proto, $scope = self._scope, $a;

      return (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope;

        return (function($base, $super) {
          function $Object(){};
          var self = $Object = $klass($base, $super, 'Object', $Object);

          var def = self._proto, $scope = self._scope, $a, $b, TMP_1;

          return ($a = ($b = $hash2(["type", "data", "name", "height", "width"], {"type": "type", "data": "data", "name": "name", "height": "height", "width": "width"})).$each, $a._p = (TMP_1 = function(name, attribute){var self = TMP_1._s || this, $a, $b, TMP_2;
if (name == null) name = nil;if (attribute == null) attribute = nil;
          return ($a = ($b = self).$defhelper, $a._p = (TMP_2 = function(value){var self = TMP_2._s || this;
              if (self.attributes == null) self.attributes = nil;
if (value == null) value = nil;
            return self.attributes['$[]='](attribute, value)}, TMP_2._s = self, TMP_2), $a).call($b, name)}, TMP_1._s = self, TMP_1), $a).call($b)
        })(self, self)
      })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/html/element/object.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$defhelper', '$[]=', '$to_s', '$join']);
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $HTML(){};
      var self = $HTML = $klass($base, $super, 'HTML', $HTML);

      var def = self._proto, $scope = self._scope, $a;

      return (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope;

        return (function($base, $super) {
          function $Td(){};
          var self = $Td = $klass($base, $super, 'Td', $Td);

          var def = self._proto, $scope = self._scope, $a, $b, TMP_1, $c, TMP_2, $d, TMP_3;

          ($a = ($b = self).$defhelper, $a._p = (TMP_1 = function(value){var self = TMP_1._s || this;
            if (self.attributes == null) self.attributes = nil;
if (value == null) value = nil;
          return self.attributes['$[]=']("colspan", value.$to_s())}, TMP_1._s = self, TMP_1), $a).call($b, "columns");

          ($a = ($c = self).$defhelper, $a._p = (TMP_2 = function(value){var self = TMP_2._s || this;
            if (self.attributes == null) self.attributes = nil;
if (value == null) value = nil;
          return self.attributes['$[]=']("rowspan", value.$to_s())}, TMP_2._s = self, TMP_2), $a).call($c, "rows");

          return ($a = ($d = self).$defhelper, $a._p = (TMP_3 = function(args){var self = TMP_3._s || this;
            if (self.attributes == null) self.attributes = nil;
args = $slice.call(arguments, 0);
          return self.attributes['$[]=']("headers", args.$join(" "))}, TMP_3._s = self, TMP_3), $a).call($d, "headers");
        })(self, self)
      })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/html/element/td.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2, $range = $opal.range;

  $opal.add_stubs(['$==', '$capitalize', '$const_defined?', '$new', '$const_get', '$each', '$to_proc', '$<<', '$heredoc', '$to_s', '$end_with?', '$[]=', '$[]', '$push', '$extend!', '$pop', '$join', '$defhelper', '$map', '$empty?', '$upcase', '$inspect']);
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $HTML(){};
      var self = $HTML = $klass($base, $super, 'HTML', $HTML);

      var def = self._proto, $scope = self._scope, $a;

      return (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4, $a, $b, TMP_5, $c, TMP_7;

        def.children = def.attributes = def.class_names = def.owner = def.last = def.name = nil;
        $opal.defs(self, '$new', TMP_1 = function(owner, name, attributes) {var $zuper = $slice.call(arguments, 0);
          var $a, self = this, $iter = TMP_1._p, $yield = $iter || nil, const$ = nil;

          if (attributes == null) {
            attributes = $hash2([], {})
          }
          TMP_1._p = null;
          if (self['$==']((($a = $scope.Element) == null ? $opal.cm('Element') : $a))) {
            } else {
            return $opal.find_super_dispatcher(self, 'new', TMP_1, $iter, $Element).apply(self, $zuper)
          };
          const$ = name.$capitalize();
          if ((($a = self['$const_defined?'](const$)) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$const_get(const$).$new(owner, name, attributes)
            } else {
            return $opal.find_super_dispatcher(self, 'new', TMP_1, $iter, $Element).apply(self, $zuper)
          };
        });

        def.$initialize = function(owner, name, attributes) {
          var self = this;

          if (attributes == null) {
            attributes = $hash2([], {})
          }
          self.owner = owner;
          self.name = name;
          self.attributes = attributes;
          self.children = [];
          return self.class_names = [];
        };

        def.$each = TMP_2 = function() {
          var $a, $b, self = this, $iter = TMP_2._p, block = $iter || nil;

          TMP_2._p = null;
          return ($a = ($b = self.children).$each, $a._p = block.$to_proc(), $a).call($b);
        };

        def['$<<'] = function(what) {
          var self = this;

          self.children['$<<'](what);
          return self;
        };

        def.$method_missing = TMP_3 = function(name, content) {
          var $a, $b, self = this, $iter = TMP_3._p, block = $iter || nil;

          if (content == null) {
            content = nil
          }
          TMP_3._p = null;
          if (content !== false && content !== nil) {
            self['$<<']((($a = ((($b = $opal.Object._scope.Paggio) == null ? $opal.cm('Paggio') : $b))._scope).Utils == null ? $a.cm('Utils') : $a.Utils).$heredoc(content.$to_s()))};
          if ((($a = name.$to_s()['$end_with?']("!")) !== nil && (!$a._isBoolean || $a == true))) {
            self.attributes['$[]=']("id", name['$[]']($range(0, -2, false)))
            } else {
            self.last = name;
            self.class_names.$push(name);
          };
          if (block !== false && block !== nil) {
            ($a = ($b = self.owner)['$extend!'], $a._p = block.$to_proc(), $a).call($b, self)};
          return self;
        };

        def['$[]'] = function(names) {
          var $a, self = this;

          names = $slice.call(arguments, 0);
          if ((($a = self.last) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            return nil
          };
          self.class_names.$pop();
          self.class_names.$push([self.last].concat(names).$join("-"));
          return self;
        };

        def.$do = TMP_4 = function() {
          var $a, $b, self = this, $iter = TMP_4._p, block = $iter || nil;

          TMP_4._p = null;
          ($a = ($b = self.owner)['$extend!'], $a._p = block.$to_proc(), $a).call($b, self);
          return self;
        };

        ($a = ($b = self).$defhelper, $a._p = (TMP_5 = function(hash){var self = TMP_5._s || this, $a, $b, TMP_6;
          if (self.attributes == null) self.attributes = nil;
if (hash == null) hash = nil;
        return self.attributes['$[]=']("style", ($a = ($b = hash).$map, $a._p = (TMP_6 = function(name, value){var self = TMP_6._s || this;
if (name == null) name = nil;if (value == null) value = nil;
          return "" + (name) + ": " + (value)}, TMP_6._s = self, TMP_6), $a).call($b).$join(";"))}, TMP_5._s = self, TMP_5), $a).call($b, "style");

        ($a = ($c = self).$defhelper, $a._p = (TMP_7 = function(hash){var self = TMP_7._s || this, $a, $b, TMP_8;
if (hash == null) hash = nil;
        return ($a = ($b = hash).$each, $a._p = (TMP_8 = function(name, value){var self = TMP_8._s || this;
            if (self.attributes == null) self.attributes = nil;
if (name == null) name = nil;if (value == null) value = nil;
          return self.attributes['$[]=']("data-" + (name), value.$to_s())}, TMP_8._s = self, TMP_8), $a).call($b)}, TMP_7._s = self, TMP_7), $a).call($c, "data");

        return (def.$inspect = function() {
          var $a, self = this;

          if ((($a = self.children['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
            return "#<HTML::Element(" + (self.name.$upcase()) + ")>"
            } else {
            return "#<HTML::Element(" + (self.name.$upcase()) + "): " + (self.children.$inspect()['$[]']($range(1, -2, false))) + ">"
          };
        }, nil) && 'inspect';
      })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/html/element.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $range = $opal.range;

  $opal.add_stubs(['$attr_reader', '$raise', '$==', '$arity', '$instance_exec', '$to_proc', '$call', '$<<', '$first', '$===', '$instance_eval', '$each', '$end_with?', '$to_s', '$empty?', '$heredoc', '$shift', '$new', '$[]', '$inspect']);
  ;
  ;
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $HTML(){};
      var self = $HTML = $klass($base, $super, 'HTML', $HTML);

      var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_4, TMP_5;

      def.current = def.roots = def.version = nil;
      self.$attr_reader("version");

      def.$initialize = TMP_1 = function(version) {
        var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil;

        if (version == null) {
          version = 5
        }
        TMP_1._p = null;
        if (block !== false && block !== nil) {
          } else {
          (($a = $opal.Object._scope.Kernel) == null ? $opal.cm('Kernel') : $a).$raise((($a = $opal.Object._scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no block given")
        };
        self.version = version;
        self.roots = [];
        self.current = nil;
        if (block.$arity()['$=='](0)) {
          return ($a = ($b = self).$instance_exec, $a._p = block.$to_proc(), $a).call($b)
          } else {
          return block.$call(self)
        };
      };

      def['$<<'] = function(what) {
        var $a, self = this;

        return (((($a = self.current) !== false && $a !== nil) ? $a : self.roots))['$<<'](what);
      };

      def['$root!'] = function() {
        var self = this;

        return self.roots.$first();
      };

      def['$roots!'] = function() {
        var self = this;

        return self.roots;
      };

      def['$element!'] = function() {
        var self = this;

        return self.current;
      };

      def['$extend!'] = TMP_2 = function(element) {
        var $a, $b, TMP_3, self = this, $iter = TMP_2._p, block = $iter || nil, old = nil, result = nil;

        if (element == null) {
          element = nil
        }
        TMP_2._p = null;
        $a = [self.current, element], old = $a[0], self.current = $a[1];
        result = block.$call(self);
        if ((($a = (($b = $opal.Object._scope.String) == null ? $opal.cm('String') : $b)['$==='](result)) !== nil && (!$a._isBoolean || $a == true))) {
          ($a = ($b = self.current).$instance_eval, $a._p = (TMP_3 = function(){var self = TMP_3._s || this;

          return self.inner_html = result}, TMP_3._s = self, TMP_3), $a).call($b)};
        self.current = old;
        return self;
      };

      def.$each = TMP_4 = function() {
        var $a, $b, self = this, $iter = TMP_4._p, block = $iter || nil;

        TMP_4._p = null;
        return ($a = ($b = self.roots).$each, $a._p = block.$to_proc(), $a).call($b);
      };

      def.$method_missing = TMP_5 = function(name, args) {var $zuper = $slice.call(arguments, 0);
        var $a, $b, $c, TMP_6, self = this, $iter = TMP_5._p, block = $iter || nil, content = nil, element = nil, parent = nil, result = nil;

        args = $slice.call(arguments, 1);
        TMP_5._p = null;
        if ((($a = name.$to_s()['$end_with?']("!")) !== nil && (!$a._isBoolean || $a == true))) {
          return $opal.find_super_dispatcher(self, 'method_missing', TMP_5, $iter).apply(self, $zuper)};
        if ((($a = ((($b = args['$empty?']()) !== false && $b !== nil) ? $b : (($c = $opal.Object._scope.Hash) == null ? $opal.cm('Hash') : $c)['$==='](args.$first()))) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          content = (($a = ((($b = $opal.Object._scope.Paggio) == null ? $opal.cm('Paggio') : $b))._scope).Utils == null ? $a.cm('Utils') : $a.Utils).$heredoc(args.$shift().$to_s())
        };
        element = ($a = (($b = $scope.Element) == null ? $opal.cm('Element') : $b)).$new.apply($a, [self, name].concat(args));
        if (content !== false && content !== nil) {
          element['$<<'](content)};
        if (block !== false && block !== nil) {
          parent = self.current;
          self.current = element;
          result = block.$call(self);
          self.current = parent;
          if ((($b = (($c = $opal.Object._scope.String) == null ? $opal.cm('String') : $c)['$==='](result)) !== nil && (!$b._isBoolean || $b == true))) {
            ($b = ($c = element).$instance_eval, $b._p = (TMP_6 = function(){var self = TMP_6._s || this;

            return self.inner_html = result}, TMP_6._s = self, TMP_6), $b).call($c)};};
        self['$<<'](element);
        return element;
      };

      return (def.$inspect = function() {
        var $a, self = this;

        if ((($a = self.roots['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
          return "#<HTML(" + (self.version) + ")>"
          } else {
          return "#<HTML(" + (self.version) + "): " + (self.roots.$inspect()['$[]']($range(1, -2, false))) + ">"
        };
      }, nil) && 'inspect';
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/html.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, $b, TMP_5, $c, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$map', '$to_proc', '$attr_reader', '$===', '$respond_to?', '$raise', '$class', '$to_u', '$new', '$==', '$convert', '$type', '$number', '$hash', '$each', '$define_method', '$+', '$compatible?', '$-', '$*', '$/', '$to_i', '$to_f', '$private', '$include?', '$class_eval', '$old_percent', '$match', '$[]', '$__send__', '$downcase']);
  (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $CSS(){};
      var self = $CSS = $klass($base, $super, 'CSS', $CSS);

      var def = self._proto, $scope = self._scope;

      return (function($base, $super) {
        function $Unit(){};
        var self = $Unit = $klass($base, $super, 'Unit', $Unit);

        var def = self._proto, $scope = self._scope, $a, $b, $c, $d, TMP_1, $e;

        def.type = def.number = nil;
        $opal.cdecl($scope, 'TYPES', ($a = ($b = ["em", "ex", "ch", "rem", "vh", "vw", "vmin", "vmax", "px", "mm", "cm", "in", "pt", "pc", "s", "deg"]).$map, $a._p = "to_sym".$to_proc(), $a).call($b));

        $opal.cdecl($scope, 'COMPATIBLE', ($a = ($c = ["in", "pt", "mm", "cm", "px", "pc"]).$map, $a._p = "to_sym".$to_proc(), $a).call($c));

        self.$attr_reader("type", "number");

        def.$initialize = function(number, type) {
          var self = this;

          self.number = number;
          return self.type = type;
        };

        def.$coerce = function(other) {
          var self = this;

          return [self, other];
        };

        def['$=='] = function(other) {
          var $a, $b, self = this;

          if ((($a = (($b = $scope.Unit) == null ? $opal.cm('Unit') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            if ((($a = other['$respond_to?']("to_u")) !== nil && (!$a._isBoolean || $a == true))) {
              } else {
              self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "no implicit conversion of " + (other.$class()) + " into Unit")
            };
            other = other.$to_u();
          };
          if ((($a = (($b = $scope.Unit) == null ? $opal.cm('Unit') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            other = (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(other, self.type)
          };
          return self.number['$=='](self.$convert(other, self.type));
        };

        def['$==='] = function(other) {
          var $a, self = this;

          return (($a = self.type['$=='](other.$type())) ? self.number['$=='](other.$number()) : $a);
        };

        $opal.defn(self, '$eql?', def['$==']);

        def.$hash = function() {
          var self = this;

          return [self.number, self.type].$hash();
        };

        ($a = ($d = (($e = $scope.TYPES) == null ? $opal.cm('TYPES') : $e)).$each, $a._p = (TMP_1 = function(name){var self = TMP_1._s || this, $a, $b, TMP_2;
if (name == null) name = nil;
        return ($a = ($b = self).$define_method, $a._p = (TMP_2 = function(){var self = TMP_2._s || this, $a;

          return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.$convert(self, name), name)}, TMP_2._s = self, TMP_2), $a).call($b, name)}, TMP_1._s = self, TMP_1), $a).call($d);

        def['$+'] = function(other) {
          var $a, $b, self = this;

          if ((($a = (($b = $scope.Unit) == null ? $opal.cm('Unit') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number['$+'](other), self.type)
          };
          if (self.type['$=='](other.$type())) {
            return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number['$+'](other.$number()), self.type)
          } else if ((($a = ($b = self['$compatible?'](self), $b !== false && $b !== nil ?self['$compatible?'](other) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number['$+'](self.$convert(other, self.type)), self.type)
            } else {
            return self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "" + (other.$type()) + " isn't compatible with " + (self.type))
          };
        };

        def['$-'] = function(other) {
          var $a, $b, self = this;

          if ((($a = (($b = $scope.Unit) == null ? $opal.cm('Unit') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number['$-'](other), self.type)
          };
          if (self.type['$=='](other.$type())) {
            return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number['$-'](other.$number()), self.type)
          } else if ((($a = ($b = self['$compatible?'](self), $b !== false && $b !== nil ?self['$compatible?'](other) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number['$-'](self.$convert(other, self.type)), self.type)
            } else {
            return self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "" + (other.$type()) + " isn't compatible with " + (self.type))
          };
        };

        def['$*'] = function(other) {
          var $a, $b, self = this;

          if ((($a = (($b = $scope.Unit) == null ? $opal.cm('Unit') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number['$*'](other), self.type)
          };
          if (self.type['$=='](other.$type())) {
            return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number['$*'](other.$number()), self.type)
          } else if ((($a = ($b = self['$compatible?'](self), $b !== false && $b !== nil ?self['$compatible?'](other) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number['$*'](self.$convert(other, self.type)), self.type)
            } else {
            return self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "" + (other.$type()) + " isn't compatible with " + (self.type))
          };
        };

        def['$/'] = function(other) {
          var $a, $b, self = this;

          if ((($a = (($b = $scope.Unit) == null ? $opal.cm('Unit') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number['$/'](other), self.type)
          };
          if (self.type['$=='](other.$type())) {
            return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number['$/'](other.$number()), self.type)
          } else if ((($a = ($b = self['$compatible?'](self), $b !== false && $b !== nil ?self['$compatible?'](other) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number['$/'](self.$convert(other, self.type)), self.type)
            } else {
            return self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "" + (other.$type()) + " isn't compatible with " + (self.type))
          };
        };

        def['$-@'] = function() {
          var $a, self = this;

          return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number['$*'](-1), self.type);
        };

        def['$+@'] = function() {
          var $a, self = this;

          return (($a = $scope.Unit) == null ? $opal.cm('Unit') : $a).$new(self.number, self.type);
        };

        def.$to_i = function() {
          var self = this;

          return self.number.$to_i();
        };

        def.$to_f = function() {
          var self = this;

          return self.number.$to_f();
        };

        def.$to_u = function() {
          var self = this;

          return self;
        };

        def.$to_s = function() {
          var self = this;

          return "" + (self.number) + (self.type);
        };

        $opal.defn(self, '$to_str', def.$to_s);

        $opal.defn(self, '$inspect', def.$to_s);

        self.$private();

        def['$compatible?'] = function(unit) {
          var $a, self = this;

          return (($a = $scope.COMPATIBLE) == null ? $opal.cm('COMPATIBLE') : $a)['$include?'](unit.$type());
        };

        return (def.$convert = function(unit, type) {
          var self = this, value = nil, px = nil, $case = nil;

          value = unit.$number();
          if (unit.$type()['$=='](type)) {
            return value};
          px = (function() {$case = unit.$type();if ("in"['$===']($case)) {return value['$*'](96)}else if ("pt"['$===']($case)) {return value['$*'](4.0)['$/'](3.0)}else if ("pc"['$===']($case)) {return value['$/'](12)['$*'](4.0)['$/'](3.0)}else if ("mm"['$===']($case)) {return value['$*'](3.77953)}else if ("cm"['$===']($case)) {return value['$*'](10)['$*'](3.77953)}else if ("px"['$===']($case)) {return value}else { return nil }})();
          return (function() {$case = type;if ("in"['$===']($case)) {return px['$/'](96.0)}else if ("pt"['$===']($case)) {return px['$/'](4.0)['$/'](3.0)}else if ("pc"['$===']($case)) {return px['$*'](12)['$/'](4.0)['$/'](3.0)}else if ("mm"['$===']($case)) {return px['$/'](3.77953)}else if ("cm"['$===']($case)) {return px['$/'](10)['$/'](3.77953)}else if ("px"['$===']($case)) {return px}else { return nil }})();
        }, nil) && 'convert';
      })(self, null)
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null);
  (function($base, $super) {
    function $Numeric(){};
    var self = $Numeric = $klass($base, $super, 'Numeric', $Numeric);

    var def = self._proto, $scope = self._scope, $a, $b, TMP_3, $c, $d, $e, $f;

    ($a = ($b = (($c = ((($d = ((($e = ((($f = $scope.Paggio) == null ? $opal.cm('Paggio') : $f))._scope).CSS == null ? $e.cm('CSS') : $e.CSS))._scope).Unit == null ? $d.cm('Unit') : $d.Unit))._scope).TYPES == null ? $c.cm('TYPES') : $c.TYPES)).$each, $a._p = (TMP_3 = function(name){var self = TMP_3._s || this, $a, $b, TMP_4;
if (name == null) name = nil;
    return ($a = ($b = self).$define_method, $a._p = (TMP_4 = function(){var self = TMP_4._s || this, $a, $b, $c;

      return (($a = ((($b = ((($c = $scope.Paggio) == null ? $opal.cm('Paggio') : $c))._scope).CSS == null ? $b.cm('CSS') : $b.CSS))._scope).Unit == null ? $a.cm('Unit') : $a.Unit).$new(self, name)}, TMP_4._s = self, TMP_4), $a).call($b, name)}, TMP_3._s = self, TMP_3), $a).call($b);

    return (def.$to_u = function() {
      var self = this;

      return self;
    }, nil) && 'to_u';
  })(self, null);
  ($a = ($b = [(($c = $scope.Fixnum) == null ? $opal.cm('Fixnum') : $c), (($c = $scope.Float) == null ? $opal.cm('Float') : $c)]).$each, $a._p = (TMP_5 = function(klass){var self = TMP_5._s || this, $a, $b, TMP_6;
if (klass == null) klass = nil;
  return ($a = ($b = klass).$class_eval, $a._p = (TMP_6 = function(){var self = TMP_6._s || this;

    self._proto.$old_percent = self._proto['$%'];
      return ($opal.defn(self, '$%', function(other) {
        var $a, $b, $c, self = this;

        if (other == null) {
          other = nil
        }
        if (other !== false && other !== nil) {
          return self.$old_percent(other)
          } else {
          return (($a = ((($b = ((($c = $scope.Paggio) == null ? $opal.cm('Paggio') : $c))._scope).CSS == null ? $b.cm('CSS') : $b.CSS))._scope).Unit == null ? $a.cm('Unit') : $a.Unit).$new(self, "%")
        };
      }), nil) && '%';}, TMP_6._s = self, TMP_6), $a).call($b)}, TMP_5._s = self, TMP_5), $a).call($b);
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self._proto, $scope = self._scope;

    return (def.$to_u = function() {
      var $a, self = this, matches = nil, value = nil, unit = nil;

      if ((($a = matches = self.$match(/^([\d+.]+)(.+)?$/)) !== nil && (!$a._isBoolean || $a == true))) {
        value = matches['$[]'](1).$to_f();
        if ((($a = unit = matches['$[]'](2)) !== nil && (!$a._isBoolean || $a == true))) {
          return value.$__send__(unit.$downcase())
          } else {
          return value
        };
        } else {
        return 0
      };
    }, nil) && 'to_u'
  })(self, null);
  return (function($base, $super) {
    function $NilClass(){};
    var self = $NilClass = $klass($base, $super, 'NilClass', $NilClass);

    var def = self._proto, $scope = self._scope;

    return (def.$to_u = function() {
      var self = this;

      return 0;
    }, nil) && 'to_u'
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/css/unit.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$each', '$define_method', '$new', '$map', '$to_proc']);
  (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $CSS(){};
      var self = $CSS = $klass($base, $super, 'CSS', $CSS);

      var def = self._proto, $scope = self._scope;

      return (function($base, $super) {
        function $Color(){};
        var self = $Color = $klass($base, $super, 'Color', $Color);

        var def = self._proto, $scope = self._scope;

        return (def.$initialize = function(value, type) {
          var self = this;

          self.internal = value;
          return self.type = type;
        }, nil) && 'initialize'
      })(self, null)
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null);
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self._proto, $scope = self._scope, $a, $b, TMP_1, $c, $d;

    return ($a = ($b = ($c = ($d = ["rgb", "rgba", "hsl", "hsla"]).$map, $c._p = "to_sym".$to_proc(), $c).call($d)).$each, $a._p = (TMP_1 = function(name){var self = TMP_1._s || this, $a, $b, TMP_2;
if (name == null) name = nil;
    return ($a = ($b = self).$define_method, $a._p = (TMP_2 = function(){var self = TMP_2._s || this, $a, $b, $c;

      return (($a = ((($b = ((($c = $scope.Paggio) == null ? $opal.cm('Paggio') : $c))._scope).CSS == null ? $b.cm('CSS') : $b.CSS))._scope).Color == null ? $a.cm('Color') : $a.Color).$new(self, name)}, TMP_2._s = self, TMP_2), $a).call($b, name)}, TMP_1._s = self, TMP_1), $a).call($b)
  })(self, null);
  return (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self._proto, $scope = self._scope, $a, $b, TMP_3, $c, $d;

    return ($a = ($b = ($c = ($d = ["rgb", "rgba", "hsl", "hsla"]).$map, $c._p = "to_sym".$to_proc(), $c).call($d)).$each, $a._p = (TMP_3 = function(name){var self = TMP_3._s || this, $a, $b, TMP_4;
if (name == null) name = nil;
    return ($a = ($b = self).$define_method, $a._p = (TMP_4 = function(){var self = TMP_4._s || this, $a, $b, $c;

      return (($a = ((($b = ((($c = $scope.Paggio) == null ? $opal.cm('Paggio') : $c))._scope).CSS == null ? $b.cm('CSS') : $b.CSS))._scope).Color == null ? $a.cm('Color') : $a.Color).$new(self, name)}, TMP_4._s = self, TMP_4), $a).call($b, name)}, TMP_3._s = self, TMP_3), $a).call($b)
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/css/color.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $range = $opal.range, $hash2 = $opal.hash2;

  $opal.add_stubs(['$new', '$==', '$arity', '$instance_exec', '$to_proc', '$call', '$empty?', '$each', '$inspect', '$===', '$first', '$>', '$length', '$raise', '$style', '$name', '$value', '$[]', '$join', '$map', '$to_i', '$*', '$to_s', '$end_with?', '$respond_to?', '$__send__', '$<<', '$last', '$pop', '$!', '$other', '$shift', '$horizontal?', '$private']);
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $CSS(){};
      var self = $CSS = $klass($base, $super, 'CSS', $CSS);

      var def = self._proto, $scope = self._scope, $a;

      return (function($base, $super) {
        function $Definition(){};
        var self = $Definition = $klass($base, $super, 'Definition', $Definition);

        var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_11;

        def.style = def.important = nil;
        $opal.cdecl($scope, 'Style', (($a = $opal.Object._scope.Struct) == null ? $opal.cm('Struct') : $a).$new("name", "value", "important"));

        def.$initialize = TMP_1 = function() {
          var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil;

          TMP_1._p = null;
          self.style = [];
          if (block !== false && block !== nil) {
            if (block.$arity()['$=='](0)) {
              return ($a = ($b = self).$instance_exec, $a._p = block.$to_proc(), $a).call($b)
              } else {
              return block.$call(self)
            }
            } else {
            return nil
          };
        };

        def['$empty?'] = function() {
          var self = this;

          return self.style['$empty?']();
        };

        def.$each = TMP_2 = function() {
          var $a, $b, self = this, $iter = TMP_2._p, block = $iter || nil;

          TMP_2._p = null;
          return ($a = ($b = self.style).$each, $a._p = block.$to_proc(), $a).call($b);
        };

        def.$gradient = function(args) {
          var $a, $b, self = this;

          args = $slice.call(arguments, 0);
          return ($a = (($b = $scope.Gradient) == null ? $opal.cm('Gradient') : $b)).$new.apply($a, [].concat(args));
        };

        def.$url = function(arg) {
          var self = this;

          return "url(" + (arg.$inspect()) + ")";
        };

        def.$background = function(args) {
          var $a, $b, TMP_3, $c, TMP_4, self = this;

          args = $slice.call(arguments, 0);
          if ((($a = (($b = $scope.Gradient) == null ? $opal.cm('Gradient') : $b)['$==='](args.$first())) !== nil && (!$a._isBoolean || $a == true))) {
            if (args.$length()['$>'](1)) {
              self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "multiple gradients not implemented yet")};
            return ($a = ($b = args.$first()).$each, $a._p = (TMP_3 = function(s){var self = TMP_3._s || this, $a;
if (s == null) s = nil;
            return self.$style(((($a = s.$name()) !== false && $a !== nil) ? $a : "background-image"), s.$value())}, TMP_3._s = self, TMP_3), $a).call($b);
          } else if ((($a = (($c = $opal.Object._scope.Hash) == null ? $opal.cm('Hash') : $c)['$==='](args.$first())) !== nil && (!$a._isBoolean || $a == true))) {
            return ($a = ($c = args.$first()).$each, $a._p = (TMP_4 = function(sub, value){var self = TMP_4._s || this;
if (sub == null) sub = nil;if (value == null) value = nil;
            return self.$style("background-" + (sub), value)}, TMP_4._s = self, TMP_4), $a).call($c)
            } else {
            return self.$style("background", args)
          };
        };

        def.$border = function(args) {
          var $a, $b, TMP_5, self = this, options = nil;

          args = $slice.call(arguments, 0);
          if ((($a = (($b = $opal.Object._scope.Hash) == null ? $opal.cm('Hash') : $b)['$==='](args.$first())) !== nil && (!$a._isBoolean || $a == true))) {
            if (args.$length()['$=='](1)) {
              options = args.$first()};
            return ($a = ($b = options).$each, $a._p = (TMP_5 = function(name, value){var self = TMP_5._s || this, $a, $b, TMP_6, $c, TMP_8, $case = nil;
if (name == null) name = nil;if (value == null) value = nil;
            return (function() {$case = name;if ("radius"['$===']($case)) {if ((($a = (($b = $opal.Object._scope.Hash) == null ? $opal.cm('Hash') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
                return ($a = ($b = value).$each, $a._p = (TMP_6 = function(horizontal, value){var self = TMP_6._s || this, $a, $b, TMP_7;
if (horizontal == null) horizontal = nil;if (value == null) value = nil;
                return ($a = ($b = value).$each, $a._p = (TMP_7 = function(vertical, value){var self = TMP_7._s || this;
if (vertical == null) vertical = nil;if (value == null) value = nil;
                  self.$style("-moz-border-radius-" + (horizontal) + (vertical), value);
                    self.$style("-webkit-border-" + (horizontal) + "-" + (vertical) + "-radius", value);
                    return self.$style("border-" + (horizontal) + "-" + (vertical) + "-radius", value);}, TMP_7._s = self, TMP_7), $a).call($b)}, TMP_6._s = self, TMP_6), $a).call($b)
                } else {
                self.$style("-moz-border-radius", value);
                self.$style("-webkit-border-radius", value);
                return self.$style("border-radius", value);
              }}else if ("color"['$===']($case)) {if ((($a = (($c = $opal.Object._scope.Hash) == null ? $opal.cm('Hash') : $c)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
                return ($a = ($c = value).$each, $a._p = (TMP_8 = function(name, value){var self = TMP_8._s || this;
if (name == null) name = nil;if (value == null) value = nil;
                return self.$style("border-" + (name) + "-color", value)}, TMP_8._s = self, TMP_8), $a).call($c)
                } else {
                return self.$style("border-color", value)
              }}else {return self.$style("border-" + (name), value)}})()}, TMP_5._s = self, TMP_5), $a).call($b);
            } else {
            return self.$style("border", args)
          };
        };

        def.$box = function(options) {
          var $a, $b, TMP_9, self = this;

          if ((($a = (($b = $opal.Object._scope.Hash) == null ? $opal.cm('Hash') : $b)['$==='](options)) !== nil && (!$a._isBoolean || $a == true))) {
            return ($a = ($b = options).$each, $a._p = (TMP_9 = function(name, value){var self = TMP_9._s || this, $a, $b, TMP_10, $case = nil;
if (name == null) name = nil;if (value == null) value = nil;
            return (function() {$case = name;if ("shadow"['$===']($case)) {if ((($a = (($b = $opal.Object._scope.Array) == null ? $opal.cm('Array') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
                if ((($a = (($b = $opal.Object._scope.Array) == null ? $opal.cm('Array') : $b)['$==='](value['$[]'](0))) !== nil && (!$a._isBoolean || $a == true))) {
                  value = ($a = ($b = value).$map, $a._p = (TMP_10 = function(v){var self = TMP_10._s || this;
if (v == null) v = nil;
                  return v.$join(" ")}, TMP_10._s = self, TMP_10), $a).call($b).$join(", ")
                  } else {
                  value = value.$join(" ")
                }};
              self.$style("-moz-box-shadow", value);
              self.$style("-webkit-box-shadow", value);
              return self.$style("box-shadow", value);}else {return self.$style("box-" + (name), value)}})()}, TMP_9._s = self, TMP_9), $a).call($b)
            } else {
            return self.$style("box", options)
          };
        };

        def.$opacity = function(value) {
          var self = this;

          self.$style("opacity", value);
          self.$style("-moz-opacity", value);
          self.$style("-ms-filter", "\"progid:DXImageTransform.Microsoft.Alpha(Opacity=" + ((value['$*'](100)).$to_i()) + ")\"");
          return self.$style("filter", "alpha(opacity=" + ((value['$*'](100)).$to_i()) + ")");
        };

        def.$animation = function(args) {
          var self = this;

          args = $slice.call(arguments, 0);
          self.$style("animation", args);
          return self.$style("-webkit-animation", args);
        };

        def.$transition = function(args) {
          var self = this;

          args = $slice.call(arguments, 0);
          self.$style("transition", args);
          self.$style("-webkit-transition", args);
          return self.$style("-moz-transition", args);
        };

        def.$method_missing = TMP_11 = function(name, args) {
          var $a, $b, $c, TMP_12, self = this, $iter = TMP_11._p, block = $iter || nil, important = nil, argument = nil;

          args = $slice.call(arguments, 1);
          TMP_11._p = null;
          name = name.$to_s();
          important = name['$end_with?']("!");
          if (important !== false && important !== nil) {
            name = name['$[]']($range(0, -2, false))};
          if (important !== false && important !== nil) {
            self.important = true};
          if ((($a = (($b = important !== false && important !== nil) ? self['$respond_to?'](name) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            ($a = ($b = self).$__send__, $a._p = block.$to_proc(), $a).apply($b, [name].concat(args));
            self.important = false;
            return nil;};
          if (args.$length()['$=='](1)) {
            argument = args.$first();
            if ((($a = (($c = $opal.Object._scope.Hash) == null ? $opal.cm('Hash') : $c)['$==='](argument)) !== nil && (!$a._isBoolean || $a == true))) {
              ($a = ($c = argument).$each, $a._p = (TMP_12 = function(sub, value){var self = TMP_12._s || this;
if (sub == null) sub = nil;if (value == null) value = nil;
              return self.$style("" + (name) + "-" + (sub), value)}, TMP_12._s = self, TMP_12), $a).call($c)
              } else {
              self.$style(name, argument)
            };
            } else {
            self.$style(name, args.$join(" "))
          };
          self.important = false;
          return self;
        };

        def.$style = function(name, value, important) {
          var $a, $b, self = this;

          if (value == null) {
            value = nil
          }
          if (important == null) {
            important = self.important
          }
          if ((($a = (($b = $opal.Object._scope.Array) == null ? $opal.cm('Array') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
            value = value.$join(" ")};
          if ((($a = (($b = $scope.Style) == null ? $opal.cm('Style') : $b)['$==='](name)) !== nil && (!$a._isBoolean || $a == true))) {
            return self.style['$<<'](name)
            } else {
            return self.style['$<<']((($a = $scope.Style) == null ? $opal.cm('Style') : $a).$new(name, value, important))
          };
        };

        def['$style!'] = function(name, value) {
          var self = this;

          if (value == null) {
            value = nil
          }
          return self.$style(name, value, true);
        };

        return (function($base, $super) {
          function $Gradient(){};
          var self = $Gradient = $klass($base, $super, 'Gradient', $Gradient);

          var def = self._proto, $scope = self._scope, TMP_13;

          def.to = def.from = def.start = def.end = nil;
          def.$initialize = function(args) {
            var $a, $b, self = this, options = nil;

            args = $slice.call(arguments, 0);
            options = (function() {if ((($a = (($b = $opal.Object._scope.Hash) == null ? $opal.cm('Hash') : $b)['$==='](args.$last())) !== nil && (!$a._isBoolean || $a == true))) {
              return args.$pop()
              } else {
              return $hash2([], {})
            }; return nil; })();
            self.to = options['$[]']("to");
            self.from = options['$[]']("from");
            if ((($a = ($b = self.to, $b !== false && $b !== nil ?self.from['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
              self.from = self.$other(self.to)
            } else if ((($a = ($b = self.from, $b !== false && $b !== nil ?self.to['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
              self.to = self.$other(self.from)};
            self.start = args.$shift();
            return self.end = args.$shift();
          };

          def.$each = TMP_13 = function() {
            var $a, self = this, $iter = TMP_13._p, block = $iter || nil;

            TMP_13._p = null;
            block.$call(self.$style("-moz-linear-gradient(" + (self.to) + ", " + (self.start) + " 0%, " + (self.end) + " 100%)"));
            if ((($a = self['$horizontal?']()) !== nil && (!$a._isBoolean || $a == true))) {
              block.$call(self.$style("-webkit-gradient(linear, " + (self.from) + " top, " + (self.to) + " top, color-stop(0%, " + (self.start) + "), color-stop(100%, " + (self.end) + "))"))
              } else {
              block.$call(self.$style("-webkit-gradient(linear, left " + (self.from) + ", left " + (self.to) + ", color-stop(0%, " + (self.start) + "), color-stop(100%, " + (self.end) + "))"))
            };
            block.$call(self.$style("-webkit-linear-gradient(" + (self.to) + ", " + (self.start) + " 0%, " + (self.end) + " 100%)"));
            block.$call(self.$style("-o-linear-gradient(" + (self.to) + ", " + (self.start) + " 0%, " + (self.end) + " 100%)"));
            block.$call(self.$style("-ms-linear-gradient(" + (self.to) + ", " + (self.start) + " 0%, " + (self.end) + " 100%)"));
            return block.$call(self.$style("linear-gradient(to " + (self.to) + ", " + (self.start) + " 0%, " + (self.end) + " 100%)"));
          };

          def['$horizontal?'] = function() {
            var $a, self = this;

            return ((($a = self.to['$==']("left")) !== false && $a !== nil) ? $a : self.to['$==']("right"));
          };

          def['$vertical?'] = function() {
            var $a, self = this;

            return ((($a = self.to['$==']("top")) !== false && $a !== nil) ? $a : self.to['$==']("bottom"));
          };

          self.$private();

          def.$other = function(side) {
            var self = this, $case = nil;

            return (function() {$case = side;if ("left"['$===']($case)) {return "right"}else if ("right"['$===']($case)) {return "left"}else if ("top"['$===']($case)) {return "bottom"}else if ("bottom"['$===']($case)) {return "top"}else { return nil }})();
          };

          return (def.$style = function(args) {
            var $a, $b, self = this;

            args = $slice.call(arguments, 0);
            if (args.$length()['$=='](1)) {
              return (($a = $scope.Style) == null ? $opal.cm('Style') : $a).$new(nil, args.$first())
              } else {
              return ($a = (($b = $scope.Style) == null ? $opal.cm('Style') : $b)).$new.apply($a, [].concat(args))
            };
          }, nil) && 'style';
        })(self, null);
      })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a))
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/css/definition.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $range = $opal.range;

  $opal.add_stubs(['$new', '$each', '$start_with?', '$+', '$[]', '$==', '$attr_reader', '$raise', '$arity', '$instance_exec', '$to_proc', '$call', '$any?', '$include?', '$<<', '$selector', '$pop', '$__send__', '$definition', '$last']);
  ;
  ;
  ;
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $CSS(){};
      var self = $CSS = $klass($base, $super, 'CSS', $CSS);

      var def = self._proto, $scope = self._scope, $a, TMP_2, TMP_3, TMP_6;

      def.current = nil;
      $opal.cdecl($scope, 'Rule', (($a = $opal.Object._scope.Struct) == null ? $opal.cm('Struct') : $a).$new("selector", "definition"));

      $opal.defs(self, '$selector', function(list) {
        var $a, $b, TMP_1, self = this, result = nil;

        result = "";
        ($a = ($b = list).$each, $a._p = (TMP_1 = function(part){var self = TMP_1._s || this, $a;
if (part == null) part = nil;
        if ((($a = part['$start_with?']("&")) !== nil && (!$a._isBoolean || $a == true))) {
            return result = result['$+'](part['$[]']($range(1, -1, false)))
            } else {
            return result = result['$+'](" "['$+'](part))
          }}, TMP_1._s = self, TMP_1), $a).call($b);
        if (result['$[]'](0)['$=='](" ")) {
          return result['$[]']($range(1, -1, false))
          } else {
          return result
        };
      });

      self.$attr_reader("rules");

      def.$initialize = TMP_2 = function() {
        var $a, $b, self = this, $iter = TMP_2._p, block = $iter || nil;

        TMP_2._p = null;
        if (block !== false && block !== nil) {
          } else {
          (($a = $opal.Object._scope.Kernel) == null ? $opal.cm('Kernel') : $a).$raise((($a = $opal.Object._scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no block given")
        };
        self.selector = [];
        self.current = [];
        self.rules = [];
        if (block.$arity()['$=='](0)) {
          return ($a = ($b = self).$instance_exec, $a._p = block.$to_proc(), $a).call($b)
          } else {
          return block.$call(self)
        };
      };

      def.$rule = TMP_3 = function(names) {
        var $a, $b, $c, TMP_4, TMP_5, self = this, $iter = TMP_3._p, block = $iter || nil;

        names = $slice.call(arguments, 0);
        TMP_3._p = null;
        if (block !== false && block !== nil) {
          } else {
          return nil
        };
        if ((($a = ($b = ($c = names)['$any?'], $b._p = (TMP_4 = function(n){var self = TMP_4._s || this;
if (n == null) n = nil;
        return n['$include?'](",")}, TMP_4._s = self, TMP_4), $b).call($c)) !== nil && (!$a._isBoolean || $a == true))) {
          (($a = $opal.Object._scope.Kernel) == null ? $opal.cm('Kernel') : $a).$raise((($a = $opal.Object._scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "selectors cannot contain commas")};
        return ($a = ($b = names).$each, $a._p = (TMP_5 = function(name){var self = TMP_5._s || this, $a;
          if (self.selector == null) self.selector = nil;
          if (self.current == null) self.current = nil;
          if (self.rules == null) self.rules = nil;
if (name == null) name = nil;
        self.selector['$<<'](name);
          self.current['$<<']((($a = $scope.Rule) == null ? $opal.cm('Rule') : $a).$new((($a = $scope.CSS) == null ? $opal.cm('CSS') : $a).$selector(self.selector), (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a).$new()));
          block.$call(self);
          self.selector.$pop();
          return self.rules['$<<'](self.current.$pop());}, TMP_5._s = self, TMP_5), $a).call($b);
      };

      return (def.$method_missing = TMP_6 = function(name, args) {
        var $a, $b, self = this, $iter = TMP_6._p, block = $iter || nil;

        args = $slice.call(arguments, 1);
        TMP_6._p = null;
        return ($a = ($b = self.current.$last().$definition()).$__send__, $a._p = block.$to_proc(), $a).apply($b, [name].concat(args));
      }, nil) && 'method_missing';
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a));

    return (function($base, $super) {
      function $HTML(){};
      var self = $HTML = $klass($base, $super, 'HTML', $HTML);

      var def = self._proto, $scope = self._scope, TMP_7;

      def.current = def.roots = nil;
      return (def.$style = TMP_7 = function() {
        var $a, $b, $c, self = this, $iter = TMP_7._p, block = $iter || nil;

        TMP_7._p = null;
        return (((($a = self.current) !== false && $a !== nil) ? $a : self.roots))['$<<'](($a = ($b = (($c = $scope.CSS) == null ? $opal.cm('CSS') : $c)).$new, $a._p = block.$to_proc(), $a).call($b));
      }, nil) && 'style'
    })(self, (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a));
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/css.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $range = $opal.range;

  $opal.add_stubs(['$include', '$new', '$call', '$close', '$attr_accessor', '$length', '$include?', '$!', '$check_readable', '$==', '$===', '$>=', '$raise', '$>', '$+', '$-', '$seek', '$enum_for', '$eof?', '$ord', '$[]', '$check_writable', '$String', '$write', '$closed_write?', '$closed_read?']);
  return (function($base, $super) {
    function $StringIO(){};
    var self = $StringIO = $klass($base, $super, 'StringIO', $StringIO);

    var def = self._proto, $scope = self._scope, $a, $b, TMP_1, TMP_2, TMP_3;

    def.position = def.string = def.closed = nil;
    self.$include((($a = ((($b = $scope.IO) == null ? $opal.cm('IO') : $b))._scope).Readable == null ? $a.cm('Readable') : $a.Readable));

    self.$include((($a = ((($b = $scope.IO) == null ? $opal.cm('IO') : $b))._scope).Writable == null ? $a.cm('Writable') : $a.Writable));

    $opal.defs(self, '$open', TMP_1 = function(string, mode) {
      var self = this, $iter = TMP_1._p, block = $iter || nil, io = nil, res = nil;

      if (string == null) {
        string = ""
      }
      if (mode == null) {
        mode = nil
      }
      TMP_1._p = null;
      io = self.$new(string, mode);
      res = block.$call(io);
      io.$close();
      return res;
    });

    self.$attr_accessor("string");

    def.$initialize = function(string, mode) {
      var $a, $b, self = this;

      if (string == null) {
        string = ""
      }
      if (mode == null) {
        mode = "rw"
      }
      self.string = string;
      self.position = string.$length();
      if ((($a = ($b = mode['$include?']("r"), $b !== false && $b !== nil ?mode['$include?']("w")['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return self.closed = "write"
      } else if ((($a = ($b = mode['$include?']("w"), $b !== false && $b !== nil ?mode['$include?']("r")['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return self.closed = "read"
        } else {
        return nil
      };
    };

    def['$eof?'] = function() {
      var self = this;

      self.$check_readable();
      return self.position['$=='](self.string.$length());
    };

    $opal.defn(self, '$eof', def['$eof?']);

    def.$seek = function(pos, whence) {
      var $a, $b, self = this, $case = nil;

      if (whence == null) {
        whence = (($a = ((($b = $scope.IO) == null ? $opal.cm('IO') : $b))._scope).SEEK_SET == null ? $a.cm('SEEK_SET') : $a.SEEK_SET)
      }
      $case = whence;if ((($a = ((($b = $scope.IO) == null ? $opal.cm('IO') : $b))._scope).SEEK_SET == null ? $a.cm('SEEK_SET') : $a.SEEK_SET)['$===']($case)) {if (pos['$>='](0)) {
        } else {
        self.$raise((($a = ((($b = $scope.Errno) == null ? $opal.cm('Errno') : $b))._scope).EINVAL == null ? $a.cm('EINVAL') : $a.EINVAL))
      };
      self.position = pos;}else if ((($a = ((($b = $scope.IO) == null ? $opal.cm('IO') : $b))._scope).SEEK_CUR == null ? $a.cm('SEEK_CUR') : $a.SEEK_CUR)['$===']($case)) {if (self.position['$+'](pos)['$>'](self.string.$length())) {
        self.position = self.string.$length()
        } else {
        self.position = self.position['$+'](pos)
      }}else if ((($a = ((($b = $scope.IO) == null ? $opal.cm('IO') : $b))._scope).SEEK_END == null ? $a.cm('SEEK_END') : $a.SEEK_END)['$===']($case)) {if (pos['$>'](self.string.$length())) {
        self.position = 0
        } else {
        self.position = self.position['$-'](pos)
      }};
      return 0;
    };

    def.$tell = function() {
      var self = this;

      return self.position;
    };

    $opal.defn(self, '$pos', def.$tell);

    $opal.defn(self, '$pos=', def.$seek);

    def.$rewind = function() {
      var self = this;

      return self.$seek(0);
    };

    def.$each_byte = TMP_2 = function() {
      var $a, $b, self = this, $iter = TMP_2._p, block = $iter || nil, i = nil;

      TMP_2._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each_byte")
      };
      self.$check_readable();
      i = self.position;
      while (!((($b = self['$eof?']()) !== nil && (!$b._isBoolean || $b == true)))) {
      block.$call(self.string['$[]'](i).$ord());
      i = i['$+'](1);};
      return self;
    };

    def.$each_char = TMP_3 = function() {
      var $a, $b, self = this, $iter = TMP_3._p, block = $iter || nil, i = nil;

      TMP_3._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each_char")
      };
      self.$check_readable();
      i = self.position;
      while (!((($b = self['$eof?']()) !== nil && (!$b._isBoolean || $b == true)))) {
      block.$call(self.string['$[]'](i));
      i = i['$+'](1);};
      return self;
    };

    def.$write = function(string) {
      var self = this, before = nil, after = nil;

      self.$check_writable();
      string = self.$String(string);
      if (self.string.$length()['$=='](self.position)) {
        self.string = self.string['$+'](string);
        return self.position = self.position['$+'](string.$length());
        } else {
        before = self.string['$[]']($range(0, self.position['$-'](1), false));
        after = self.string['$[]']($range(self.position['$+'](string.$length()), -1, false));
        self.string = before['$+'](string)['$+'](after);
        return self.position = self.position['$+'](string.$length());
      };
    };

    def.$read = function(length, outbuf) {
      var $a, self = this, string = nil, str = nil;

      if (length == null) {
        length = nil
      }
      if (outbuf == null) {
        outbuf = nil
      }
      self.$check_readable();
      if ((($a = self['$eof?']()) !== nil && (!$a._isBoolean || $a == true))) {
        return nil};
      string = (function() {if (length !== false && length !== nil) {
        str = self.string['$[]'](self.position, length);
        self.position = self.position['$+'](length);
        return str;
        } else {
        str = self.string['$[]']($range(self.position, -1, false));
        self.position = self.string.$length();
        return str;
      }; return nil; })();
      if (outbuf !== false && outbuf !== nil) {
        return outbuf.$write(string)
        } else {
        return string
      };
    };

    def.$close = function() {
      var self = this;

      return self.closed = "both";
    };

    def.$close_read = function() {
      var self = this;

      if (self.closed['$==']("write")) {
        return self.closed = "both"
        } else {
        return self.closed = "read"
      };
    };

    def.$close_write = function() {
      var self = this;

      if (self.closed['$==']("read")) {
        return self.closed = "both"
        } else {
        return self.closed = "write"
      };
    };

    def['$closed?'] = function() {
      var self = this;

      return self.closed['$==']("both");
    };

    def['$closed_read?'] = function() {
      var $a, self = this;

      return ((($a = self.closed['$==']("read")) !== false && $a !== nil) ? $a : self.closed['$==']("both"));
    };

    def['$closed_write?'] = function() {
      var $a, self = this;

      return ((($a = self.closed['$==']("write")) !== false && $a !== nil) ? $a : self.closed['$==']("both"));
    };

    def.$check_writable = function() {
      var $a, self = this;

      if ((($a = self['$closed_write?']()) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$raise((($a = $scope.IOError) == null ? $opal.cm('IOError') : $a), "not opened for writing")
        } else {
        return nil
      };
    };

    return (def.$check_readable = function() {
      var $a, self = this;

      if ((($a = self['$closed_read?']()) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$raise((($a = $scope.IOError) == null ? $opal.cm('IOError') : $a), "not opened for reading")
        } else {
        return nil
      };
    }, nil) && 'check_readable';
  })(self, (($a = $scope.IO) == null ? $opal.cm('IO') : $a))
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/stringio.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$[]=', '$to_h', '$[]', '$dup', '$deep_merge!', '$call', '$replace', '$===', '$new', '$merge', '$each', '$string', '$indent?', '$+', '$-', '$puts', '$*', '$chomp', '$lines', '$print', '$gsub', '$to_s', '$for', '$version', '$indent', '$format', '$instance_eval', '$empty?', '$map', '$escape', '$<<', '$join', '$definition', '$selector', '$name', '$value', '$important', '$reverse', '$rules']);
  ;
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, $a, $b, TMP_7, $c, TMP_10, $d, $e, TMP_17;

    (function($base, $super) {
      function $Formatter(){};
      var self = $Formatter = $klass($base, $super, 'Formatter', $Formatter);

      var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_4, TMP_5;

      def.options = def.io = nil;
      $opal.defs(self, '$to_h', function() {
        var $a, self = this;
        if (self.formatters == null) self.formatters = nil;

        return ((($a = self.formatters) !== false && $a !== nil) ? $a : self.formatters = $hash2([], {}));
      });

      $opal.defs(self, '$for', TMP_1 = function(klass) {
        var self = this, $iter = TMP_1._p, block = $iter || nil;

        TMP_1._p = null;
        if (block !== false && block !== nil) {
          return self.$to_h()['$[]='](klass, block)
          } else {
          return self.$to_h()['$[]'](klass)
        };
      });

      $opal.defs(self, '$options', TMP_2 = function(options) {
        var $a, self = this, $iter = TMP_2._p, block = $iter || nil, old = nil, result = nil;

        TMP_2._p = null;
        old = (($a = $scope.OPTIONS) == null ? $opal.cm('OPTIONS') : $a).$dup();
        (($a = $scope.Utils) == null ? $opal.cm('Utils') : $a)['$deep_merge!']((($a = $scope.OPTIONS) == null ? $opal.cm('OPTIONS') : $a), options);
        result = block.$call();
        (($a = $scope.OPTIONS) == null ? $opal.cm('OPTIONS') : $a).$replace(old);
        return result;
      });

      $opal.cdecl($scope, 'OPTIONS', $hash2(["indent"], {"indent": $hash2(["level", "with"], {"level": 0, "with": "\t"})}));

      def.$initialize = function(io, options) {
        var $a, $b, self = this;

        if (io == null) {
          io = nil
        }
        if (options == null) {
          options = $hash2([], {})
        }
        if ((($a = (($b = $scope.Hash) == null ? $opal.cm('Hash') : $b)['$==='](io)) !== nil && (!$a._isBoolean || $a == true))) {
          self.io = (($a = $scope.StringIO) == null ? $opal.cm('StringIO') : $a).$new();
          self.options = io;
          } else {
          self.io = ((($a = io) !== false && $a !== nil) ? $a : (($b = $scope.StringIO) == null ? $opal.cm('StringIO') : $b).$new());
          self.options = options;
        };
        return self.options = (($a = $scope.OPTIONS) == null ? $opal.cm('OPTIONS') : $a).$merge(self.options);
      };

      def.$format = function(item) {
        var $a, $b, TMP_3, $c, self = this;

        ($a = ($b = (($c = $scope.Formatter) == null ? $opal.cm('Formatter') : $c).$to_h()).$each, $a._p = (TMP_3 = function(klass, block){var self = TMP_3._s || this, $a;
if (klass == null) klass = nil;if (block == null) block = nil;
        if ((($a = klass['$==='](item)) !== nil && (!$a._isBoolean || $a == true))) {
            block.$call(self, item);
            return ($breaker.$v = nil, $breaker);
            } else {
            return nil
          }}, TMP_3._s = self, TMP_3), $a).call($b);
        return self;
      };

      def.$to_s = function() {
        var self = this;

        return self.io.$string();
      };

      def['$indent?'] = TMP_4 = function() {
        var self = this, $iter = TMP_4._p, block = $iter || nil;

        TMP_4._p = null;
        try {
        return self.options['$[]']("indent")['$[]']("level")
        } catch ($err) {if (true) {
          return false
          }else { throw $err; }
        };
      };

      def.$indent = TMP_5 = function() {
        var $a, $b, self = this, $iter = TMP_5._p, block = $iter || nil;

        TMP_5._p = null;
        if ((($a = self['$indent?']()) !== nil && (!$a._isBoolean || $a == true))) {
          ($a = "level", $b = self.options['$[]']("indent"), $b['$[]=']($a, $b['$[]']($a)['$+'](1)));
          block.$call();
          return ($a = "level", $b = self.options['$[]']("indent"), $b['$[]=']($a, $b['$[]']($a)['$-'](1)));
          } else {
          return block.$call()
        };
      };

      def.$print = function(text) {
        var $a, $b, TMP_6, self = this, level = nil;

        if ((($a = level = self['$indent?']()) !== nil && (!$a._isBoolean || $a == true))) {
          return ($a = ($b = text.$lines()).$each, $a._p = (TMP_6 = function(line){var self = TMP_6._s || this;
            if (self.io == null) self.io = nil;
            if (self.options == null) self.options = nil;
if (line == null) line = nil;
          return self.io.$puts("" + (self.options['$[]']("indent")['$[]']("with")['$*'](level)) + (line.$chomp()))}, TMP_6._s = self, TMP_6), $a).call($b)
          } else {
          return self.io.$print(text)
        };
      };

      return (def.$escape = function(string) {
        var self = this;

        return string.$to_s().$gsub(/["><']|&(?!([a-zA-Z]+|(#\d+));)/, $hash2(["&", ">", "<", "\"", "'"], {"&": "&amp;", ">": "&gt;", "<": "&lt;", "\"": "&quot;", "'": "&#39;"}));
      }, nil) && 'escape';
    })(self, null);

    ($a = ($b = (($c = $scope.Formatter) == null ? $opal.cm('Formatter') : $c)).$for, $a._p = (TMP_7 = function(f, item){var self = TMP_7._s || this, $a, $b, TMP_8, $case = nil;
if (f == null) f = nil;if (item == null) item = nil;
    $case = item.$version();if ((5)['$===']($case)) {f.$print("<!DOCTYPE html>")};
      f.$print("<html>");
      ($a = ($b = f).$indent, $a._p = (TMP_8 = function(){var self = TMP_8._s || this, $a, $b, TMP_9;

      return ($a = ($b = item).$each, $a._p = (TMP_9 = function(root){var self = TMP_9._s || this;
if (root == null) root = nil;
        return f.$format(root)}, TMP_9._s = self, TMP_9), $a).call($b)}, TMP_8._s = self, TMP_8), $a).call($b);
      return f.$print("</html>");}, TMP_7._s = self, TMP_7), $a).call($b, (($c = $scope.HTML) == null ? $opal.cm('HTML') : $c));

    ($a = ($c = (($d = $scope.Formatter) == null ? $opal.cm('Formatter') : $d)).$for, $a._p = (TMP_10 = function(f, item){var self = TMP_10._s || this, $a, $b, $c, TMP_11, TMP_12, $d, TMP_13, name = nil, attributes = nil, class_names = nil, attrs = nil;
if (f == null) f = nil;if (item == null) item = nil;
    $a = $opal.to_ary(($b = ($c = item).$instance_eval, $b._p = (TMP_11 = function(){var self = TMP_11._s || this;
        if (self.name == null) self.name = nil;
        if (self.attributes == null) self.attributes = nil;
        if (self.class_names == null) self.class_names = nil;

      return [self.name, self.attributes, self.class_names]}, TMP_11._s = self, TMP_11), $b).call($c)), name = ($a[0] == null ? nil : $a[0]), attributes = ($a[1] == null ? nil : $a[1]), class_names = ($a[2] == null ? nil : $a[2]);
      if ((($a = ($b = attributes['$empty?'](), $b !== false && $b !== nil ?class_names['$empty?']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        f.$print("<" + (name) + ">")
        } else {
        attrs = ($a = ($b = attributes).$map, $a._p = (TMP_12 = function(key, value){var self = TMP_12._s || this;
if (key == null) key = nil;if (value == null) value = nil;
        return "" + (f.$escape(key)) + "=\"" + (f.$escape(value)) + "\""}, TMP_12._s = self, TMP_12), $a).call($b);
        if ((($a = class_names['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          attrs['$<<']("class=\"" + (f.$escape(class_names.$join(" "))) + "\"")
        };
        f.$print("<" + (name) + " " + (attrs.$join(" ")) + ">");
      };
      ($a = ($d = f).$indent, $a._p = (TMP_13 = function(){var self = TMP_13._s || this, $a, $b, $c, TMP_14, TMP_15, inner = nil;

      if ((($a = inner = ($b = ($c = item).$instance_eval, $b._p = (TMP_14 = function(){var self = TMP_14._s || this;
          if (self.inner_html == null) self.inner_html = nil;

        return self.inner_html}, TMP_14._s = self, TMP_14), $b).call($c)) !== nil && (!$a._isBoolean || $a == true))) {
          return f.$print(inner)
          } else {
          return ($a = ($b = item).$each, $a._p = (TMP_15 = function(child){var self = TMP_15._s || this, $a, $b, TMP_16, $case = nil;
if (child == null) child = nil;
          return (function() {$case = child;if ((($a = $scope.String) == null ? $opal.cm('String') : $a)['$===']($case)) {return f.$print(f.$escape(child))}else if ((($a = $scope.CSS) == null ? $opal.cm('CSS') : $a)['$===']($case)) {f.$print("<style>");
            ($a = ($b = f).$indent, $a._p = (TMP_16 = function(){var self = TMP_16._s || this;

            return f.$format(child)}, TMP_16._s = self, TMP_16), $a).call($b);
            return f.$print("</style>");}else {return f.$format(child)}})()}, TMP_15._s = self, TMP_15), $a).call($b)
        }}, TMP_13._s = self, TMP_13), $a).call($d);
      return f.$print("</" + (name) + ">");}, TMP_10._s = self, TMP_10), $a).call($c, (($d = ((($e = $scope.HTML) == null ? $opal.cm('HTML') : $e))._scope).Element == null ? $d.cm('Element') : $d.Element));

    return ($a = ($d = (($e = $scope.Formatter) == null ? $opal.cm('Formatter') : $e)).$for, $a._p = (TMP_17 = function(f, item){var self = TMP_17._s || this, $a, $b, TMP_18;
if (f == null) f = nil;if (item == null) item = nil;
    return ($a = ($b = item.$rules().$reverse()).$each, $a._p = (TMP_18 = function(rule){var self = TMP_18._s || this, $a, $b, TMP_19;
if (rule == null) rule = nil;
      if ((($a = rule.$definition()['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
          return nil;};
        f.$print("" + (rule.$selector()) + " {");
        ($a = ($b = f).$indent, $a._p = (TMP_19 = function(){var self = TMP_19._s || this, $a, $b, TMP_20;

        return ($a = ($b = rule.$definition()).$each, $a._p = (TMP_20 = function(style){var self = TMP_20._s || this, $a;
if (style == null) style = nil;
          return f.$print("" + (style.$name()) + ": " + (style.$value()) + ((function() {if ((($a = style.$important()) !== nil && (!$a._isBoolean || $a == true))) {
              return " !important"
              } else {
              return nil
            }; return nil; })()) + ";")}, TMP_20._s = self, TMP_20), $a).call($b)}, TMP_19._s = self, TMP_19), $a).call($b);
        return f.$print("}");}, TMP_18._s = self, TMP_18), $a).call($b)}, TMP_17._s = self, TMP_17), $a).call($d, (($e = $scope.CSS) == null ? $opal.cm('CSS') : $e));
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio/formatter.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$options', '$to_proc', '$to_s', '$format', '$new', '$tap', '$each']);
  ;
  ;
  ;
  ;
  return (function($base, $super) {
    function $Paggio(){};
    var self = $Paggio = $klass($base, $super, 'Paggio', $Paggio);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5;

    $opal.defs(self, '$options', TMP_1 = function(options) {
      var $a, $b, $c, self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      return ($a = ($b = (($c = $scope.Formatter) == null ? $opal.cm('Formatter') : $c)).$options, $a._p = block.$to_proc(), $a).call($b, options);
    });

    $opal.defs(self, '$indent', TMP_2 = function(options) {
      var $a, $b, self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      return ($a = ($b = self).$options, $a._p = block.$to_proc(), $a).call($b, $hash2(["indent"], {"indent": options}));
    });

    $opal.defs(self, '$css', TMP_3 = function(args) {
      var $a, $b, $c, self = this, $iter = TMP_3._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_3._p = null;
      return (($a = $scope.Formatter) == null ? $opal.cm('Formatter') : $a).$new().$format(($a = ($b = (($c = $scope.CSS) == null ? $opal.cm('CSS') : $c)).$new, $a._p = block.$to_proc(), $a).apply($b, [].concat(args))).$to_s();
    });

    $opal.defs(self, '$html', TMP_4 = function(args) {
      var $a, $b, $c, self = this, $iter = TMP_4._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_4._p = null;
      return (($a = $scope.Formatter) == null ? $opal.cm('Formatter') : $a).$new().$format(($a = ($b = (($c = $scope.HTML) == null ? $opal.cm('HTML') : $c)).$new, $a._p = block.$to_proc(), $a).apply($b, [].concat(args))).$to_s();
    });

    return ($opal.defs(self, '$html!', TMP_5 = function() {
      var $a, $b, TMP_6, $c, self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      return ($a = ($b = (($c = $scope.Formatter) == null ? $opal.cm('Formatter') : $c).$new()).$tap, $a._p = (TMP_6 = function(f){var self = TMP_6._s || this, $a, $b, TMP_7, $c, $d, $e;
if (f == null) f = nil;
      return ($a = ($b = ($c = ($d = (($e = $scope.HTML) == null ? $opal.cm('HTML') : $e)).$new, $c._p = block.$to_proc(), $c).call($d)).$each, $a._p = (TMP_7 = function(root){var self = TMP_7._s || this;
if (root == null) root = nil;
        return f.$format(root)}, TMP_7._s = self, TMP_7), $a).call($b)}, TMP_6._s = self, TMP_6), $a).call($b).$to_s();
    }), nil) && 'html!';
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/paggio.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs([]);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    $opal.cdecl($scope, 'VERSION', "0.2.0.beta1")
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/version.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$new', '$encode_uri', '$to_s', '$encode_uri_component', '$[]', '$map', '$split', '$decode_uri_component', '$join']);
  (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope, $a;

    $opal.cdecl($scope, 'Size', (($a = $scope.Struct) == null ? $opal.cm('Struct') : $a).$new("width", "height"));

    $opal.cdecl($scope, 'Position', (($a = $scope.Struct) == null ? $opal.cm('Struct') : $a).$new("x", "y"));
    
  })(self);
  (function($base, $super) {
    function $Object(){};
    var self = $Object = $klass($base, $super, 'Object', $Object);

    var def = self._proto, $scope = self._scope;

    $opal.defn(self, '$encode_uri', function() {
      var self = this;

      return self.$to_s().$encode_uri();
    });

    return ($opal.defn(self, '$encode_uri_component', function() {
      var self = this;

      return self.$to_s().$encode_uri_component();
    }), nil) && 'encode_uri_component';
  })(self, null);
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self._proto, $scope = self._scope;

    def.$encode_uri_component = function() {
      var self = this;

      return encodeURIComponent(self);
    };

    def.$encode_uri = function() {
      var self = this;

      return encodeURI(self);
    };

    def.$decode_uri_component = function() {
      var self = this;

      return decodeURIComponent(self);
    };

    return (def.$decode_uri = function() {
      var self = this;

      return decodeURI(self);
    }, nil) && 'decode_uri';
  })(self, null);
  return (function($base, $super) {
    function $Hash(){};
    var self = $Hash = $klass($base, $super, 'Hash', $Hash);

    var def = self._proto, $scope = self._scope;

    $opal.defs(self, '$decode_uri', function(string) {
      var $a, $b, TMP_1, self = this;

      return self['$[]'](($a = ($b = string.$split("&")).$map, $a._p = (TMP_1 = function(part){var self = TMP_1._s || this, $a, name = nil, value = nil;
if (part == null) part = nil;
      $a = $opal.to_ary(part.$split("=")), name = ($a[0] == null ? nil : $a[0]), value = ($a[1] == null ? nil : $a[1]);
        return [name.$decode_uri_component(), value.$decode_uri_component()];}, TMP_1._s = self, TMP_1), $a).call($b));
    });

    return (def.$encode_uri = function() {
      var $a, $b, TMP_2, self = this;

      return ($a = ($b = self).$map, $a._p = (TMP_2 = function(name, value){var self = TMP_2._s || this;
if (name == null) name = nil;if (value == null) value = nil;
      return "" + (name.$to_s().$encode_uri_component()) + "=" + (value.$to_s().$encode_uri_component())}, TMP_2._s = self, TMP_2), $a).call($b).$join("&");
    }, nil) && 'encode_uri';
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/utils.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$downcase', '$===', '$!']);
  $opal.cdecl($scope, 'BROWSER_ENGINE', (function() {try {return (/MSIE|WebKit|Presto|Gecko/.exec(navigator.userAgent)[0]).$downcase() } catch ($err) { return "unknown" }})());
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    self.support = {};

    $opal.defs(self, '$supports?', function(feature) {
      var $a, $b, self = this, support = nil, $case = nil;
      if (self.support == null) self.support = nil;

      if ((($a = (typeof(self.support[feature]) !== "undefined")) !== nil && (!$a._isBoolean || $a == true))) {
        return self.support[feature]};
      support = (function() {$case = feature;if ("MutationObserver"['$===']($case)) {return (typeof(window.MutationObserver) !== "undefined")}else if ("WebSocket"['$===']($case)) {return (typeof(window.WebSocket) !== "undefined")}else if ("EventSource"['$===']($case)) {return (typeof(window.EventSource) !== "undefined")}else if ("XHR"['$===']($case)) {return (typeof(window.XMLHttpRequest) !== "undefined")}else if ("ActiveX"['$===']($case)) {return (typeof(window.ActiveXObject) !== "undefined")}else if ("Query.css"['$===']($case)) {return (typeof(Element.prototype.querySelectorAll) !== "undefined")}else if ("Query.xpath"['$===']($case)) {return (typeof(document.evaluate) !== "undefined")}else if ("Storage.local"['$===']($case)) {return (typeof(window.localStorage) !== "undefined")}else if ("Storage.global"['$===']($case)) {return (typeof(window.globalStorage) !== "undefined")}else if ("Storage.session"['$===']($case)) {return (typeof(window.sessionStorage) !== "undefined")}else if ("Immediate"['$===']($case)) {return (typeof(window.setImmediate) !== "undefined")}else if ("Immediate (Internet Explorer)"['$===']($case)) {return (typeof(window.msSetImmediate) !== "undefined")}else if ("Immediate (Firefox)"['$===']($case)) {return (typeof(window.mozSetImmediate) !== "undefined")}else if ("Immediate (Opera)"['$===']($case)) {return (typeof(window.oSetImmediate) !== "undefined")}else if ("Immediate (Chrome)"['$===']($case) || "setImmediate (Safari)"['$===']($case)) {return (typeof(window.webkitSetImmediate) !== "undefined")}else if ("CSS.computed"['$===']($case)) {return (typeof(window.getComputedStyle) !== "undefined")}else if ("CSS.current"['$===']($case)) {return (typeof(document.documentElement.currentStyle) !== "undefined")}else if ("Window.send"['$===']($case)) {if ((($a = ($b = (typeof(window.postMessage) !== "undefined"), $b !== false && $b !== nil ?(typeof(window.importScripts) !== "undefined")['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        
            var ok  = true,
                old = window.onmessage;

            window.onmessage = function() { ok = false; };
            window.postMessage("", "*")
            window.onmessage = old;
          
        return ok;
        } else {
        return nil
      }}else if ("Window.innerSize"['$===']($case)) {return (typeof(window.innerHeight) !== "undefined")}else if ("Window.outerSize"['$===']($case)) {return (typeof(window.outerHeight) !== "undefined")}else if ("Window.scroll"['$===']($case)) {return (typeof(document.documentElement.scrollLeft) !== "undefined")}else if ("Window.pageOffset"['$===']($case)) {return (typeof(window.pageXOffset) !== "undefined")}else if ("Element.addBehavior"['$===']($case)) {return (typeof(document.body.addBehavior) !== "undefined")}else if ("Element.clientSize"['$===']($case)) {return (typeof(document.documentElement.clientHeight) !== "undefined")}else if ("Element.scroll"['$===']($case)) {return (typeof(document.documentElement.scrollLeft) !== "undefined")}else if ("Element.textContent"['$===']($case)) {return (typeof(document.documentElement.textContent) !== "undefined")}else if ("Element.innerText"['$===']($case)) {return (typeof(document.documentElement.innerText) !== "undefined")}else if ("Element.matches"['$===']($case)) {return (typeof(document.documentElement.matches) !== "undefined")}else if ("Element.matches (Internet Explorer)"['$===']($case)) {return (typeof(document.documentElement.msMatchesSelector) !== "undefined")}else if ("Element.matches (Firefox)"['$===']($case)) {return (typeof(document.documentElement.mozMatchesSelector) !== "undefined")}else if ("Element.matches (Opera)"['$===']($case)) {return (typeof(document.documentElement.oMatchesSelector) !== "undefined")}else if ("Element.matches (Chrome)"['$===']($case) || "Element.matches (Safari)"['$===']($case)) {return (typeof(document.documentElement.webkitMatchesSelector) !== "undefined")}else if ("Element.getBoundingClientRect"['$===']($case)) {return (typeof(document.documentElement.getBoundingClientRect) !== "undefined")}else if ("Event.readystatechange"['$===']($case)) {return "onreadystatechange" in window.document.createElement("script");}else if ("Event.constructor"['$===']($case)) {try {
      new MouseEvent("click");
        return true;
      } catch ($err) {if (true) {
        return false
        }else { throw $err; }
      }}else if ("Event.create"['$===']($case)) {return (typeof(document.createEvent) !== "undefined")}else if ("Event.createObject"['$===']($case)) {return (typeof(document.createEventObject) !== "undefined")}else if ("Event.addListener"['$===']($case)) {return (typeof(document.addEventListener) !== "undefined")}else if ("Event.attach"['$===']($case)) {return (typeof(document.attachEvent) !== "undefined")}else if ("Event.removeListener"['$===']($case)) {return (typeof(document.removeEventListener) !== "undefined")}else if ("Event.detach"['$===']($case)) {return (typeof(document.detachEvent) !== "undefined")}else if ("Event.dispatch"['$===']($case)) {return (typeof(document.dispatchEvent) !== "undefined")}else if ("Event.fire"['$===']($case)) {return (typeof(document.fireEvent) !== "undefined")}else if (/^Event\.([A-Z].*?)$/['$===']($case)) {return (nil + "Event") in window;}else if ("Document.view"['$===']($case)) {return (typeof(document.defaultView) !== "undefined")}else if ("Document.window"['$===']($case)) {return (typeof(document.parentWindow) !== "undefined")}else if ("History"['$===']($case)) {return (typeof(window.history.pushState) !== "undefined")}else if ("History.state"['$===']($case)) {return (typeof(window.history.state) !== "undefined")}else if ("Animation.request"['$===']($case)) {return (typeof(window.requestAnimationFrame) !== "undefined")}else if ("Animation.request (Internet Explorer)"['$===']($case)) {return (typeof(window.msRequestAnimationFrame) !== "undefined")}else if ("Animation.request (Firefox)"['$===']($case)) {return (typeof(window.mozRequestAnimationFrame) !== "undefined")}else if ("Animation.request (Opera)"['$===']($case)) {return (typeof(window.oRequestAnimationFrame) !== "undefined")}else if ("Animation.request (Chrome)"['$===']($case) || "Animation.request (Safari)"['$===']($case)) {return (typeof(window.webkitRequestAnimationFrame) !== "undefined")}else if ("Animation.cancel"['$===']($case)) {return (typeof(window.cancelAnimationFrame) !== "undefined")}else if ("Animation.cancel (Internet Explorer)"['$===']($case)) {return (typeof(window.msCancelAnimationFrame) !== "undefined")}else if ("Animation.cancel (Firefox)"['$===']($case)) {return (typeof(window.mozCancelAnimationFrame) !== "undefined")}else if ("Animation.cancel (Opera)"['$===']($case)) {return (typeof(window.oCancelAnimationFrame) !== "undefined")}else if ("Animation.cancel (Chrome)"['$===']($case) || "Animation.cancel (Safari)"['$===']($case)) {return (typeof(window.webkitCancelAnimationFrame) !== "undefined")}else if ("Animation.cancelRequest"['$===']($case)) {return (typeof(window.cancelRequestAnimationFrame) !== "undefined")}else if ("Animation.cancelRequest (Internet Explorer)"['$===']($case)) {return (typeof(window.msCancelRequestAnimationFrame) !== "undefined")}else if ("Animation.cancelRequest (Firefox)"['$===']($case)) {return (typeof(window.mozCancelRequestAnimationFrame) !== "undefined")}else if ("Animation.cancelRequest (Opera)"['$===']($case)) {return (typeof(window.oCancelRequestAnimationFrame) !== "undefined")}else if ("Animation.cancelRequest (Chrome)"['$===']($case) || "Animation.cancelRequest (Safari)"['$===']($case)) {return (typeof(window.webkitCancelRequestAnimationFrame) !== "undefined")}else { return nil }})();
      return self.support[feature] = support;
    });

    $opal.defs(self, '$loaded?', function(name) {
      var self = this, $case = nil;

      return (function() {$case = name;if ("Sizzle"['$===']($case)) {return (typeof(window.Sizzle) !== "undefined")}else if ("wicked-good-xpath"['$===']($case)) {return (typeof(window.wgxpath) !== "undefined")}else { return nil }})();
    });
    
  })(self);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/support.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$attr_reader', '$convert', '$start', '$aborted?', '$raise', '$stopped?', '$to_n', '$new', '$to_proc', '$every']);
  (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Interval(){};
      var self = $Interval = $klass($base, $super, 'Interval', $Interval);

      var def = self._proto, $scope = self._scope, TMP_1;

      def.stopped = def.aborted = def.window = def.id = def.block = def.every = nil;
      self.$attr_reader("every");

      def.$initialize = TMP_1 = function(window, time) {
        var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

        TMP_1._p = null;
        self.window = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(window);
        self.every = time;
        self.block = block;
        self.aborted = false;
        self.stopped = true;
        return self.$start();
      };

      def['$stopped?'] = function() {
        var self = this;

        return self.stopped;
      };

      def['$aborted?'] = function() {
        var self = this;

        return self.aborted;
      };

      def.$abort = function() {
        var self = this;

        self.window.clearInterval(self.id);
        self.aborted = true;
        return self.id = nil;
      };

      def.$stop = function() {
        var self = this;

        self.window.clearInterval(self.id);
        self.stopped = true;
        return self.id = nil;
      };

      return (def.$start = function() {
        var $a, self = this;

        if ((($a = self['$aborted?']()) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise("the interval has been aborted")};
        if ((($a = self['$stopped?']()) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          return nil
        };
        return self.id = self.window.setInterval(self.block.$to_n(), self.every * 1000);
      }, nil) && 'start';
    })(self, null);

    (function($base, $super) {
      function $Window(){};
      var self = $Window = $klass($base, $super, 'Window', $Window);

      var def = self._proto, $scope = self._scope, TMP_2;

      def["native"] = nil;
      return (def.$every = TMP_2 = function(time) {
        var $a, $b, $c, self = this, $iter = TMP_2._p, block = $iter || nil;

        TMP_2._p = null;
        return ($a = ($b = (($c = $scope.Interval) == null ? $opal.cm('Interval') : $c)).$new, $a._p = block.$to_proc(), $a).call($b, self["native"], time);
      }, nil) && 'every'
    })(self, null);
    
  })(self);
  (function($base, $super) {
    function $Proc(){};
    var self = $Proc = $klass($base, $super, 'Proc', $Proc);

    var def = self._proto, $scope = self._scope;

    return (def.$every = function(time) {
      var $a, $b, self = this;
      if ($gvars.window == null) $gvars.window = nil;

      return ($a = ($b = $gvars.window).$every, $a._p = self.$to_proc(), $a).call($b, time);
    }, nil) && 'every'
  })(self, null);
  return (function($base) {
    var self = $module($base, 'Kernel');

    var def = self._proto, $scope = self._scope, TMP_3;

    def.$every = TMP_3 = function(time) {
      var $a, $b, self = this, $iter = TMP_3._p, block = $iter || nil;
      if ($gvars.window == null) $gvars.window = nil;

      TMP_3._p = null;
      return ($a = ($b = $gvars.window).$every, $a._p = block.$to_proc(), $a).call($b, time);
    }
        ;$opal.donate(self, ["$every"]);
  })(self);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/interval.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$attr_reader', '$convert', '$start', '$to_n', '$new', '$to_proc', '$after']);
  (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Delay(){};
      var self = $Delay = $klass($base, $super, 'Delay', $Delay);

      var def = self._proto, $scope = self._scope, TMP_1;

      def.window = def.id = def.block = def.after = nil;
      self.$attr_reader("after");

      def.$initialize = TMP_1 = function(window, time) {
        var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

        TMP_1._p = null;
        self.window = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(window);
        self.after = time;
        self.block = block;
        return self.$start();
      };

      def.$abort = function() {
        var self = this;

        return self.window.clearTimeout(self.id);
      };

      return (def.$start = function() {
        var self = this;

        return self.id = self.window.setTimeout(self.block.$to_n(), self.after * 1000);
      }, nil) && 'start';
    })(self, null);

    (function($base, $super) {
      function $Window(){};
      var self = $Window = $klass($base, $super, 'Window', $Window);

      var def = self._proto, $scope = self._scope, TMP_2;

      def["native"] = nil;
      return (def.$after = TMP_2 = function(time) {
        var $a, $b, $c, self = this, $iter = TMP_2._p, block = $iter || nil;

        TMP_2._p = null;
        return ($a = ($b = (($c = $scope.Delay) == null ? $opal.cm('Delay') : $c)).$new, $a._p = block.$to_proc(), $a).call($b, self["native"], time);
      }, nil) && 'after'
    })(self, null);
    
  })(self);
  (function($base, $super) {
    function $Proc(){};
    var self = $Proc = $klass($base, $super, 'Proc', $Proc);

    var def = self._proto, $scope = self._scope;

    return (def.$after = function(time) {
      var $a, $b, self = this;
      if ($gvars.window == null) $gvars.window = nil;

      return ($a = ($b = $gvars.window).$after, $a._p = self.$to_proc(), $a).call($b, time);
    }, nil) && 'after'
  })(self, null);
  return (function($base) {
    var self = $module($base, 'Kernel');

    var def = self._proto, $scope = self._scope, TMP_3;

    def.$after = TMP_3 = function(time) {
      var $a, $b, self = this, $iter = TMP_3._p, block = $iter || nil;
      if ($gvars.window == null) $gvars.window = nil;

      TMP_3._p = null;
      return ($a = ($b = $gvars.window).$after, $a._p = block.$to_proc(), $a).call($b, time);
    }
        ;$opal.donate(self, ["$after"]);
  })(self);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/delay.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$to_n', '$supports?', '$raise']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Window(){};
      var self = $Window = $klass($base, $super, 'Window', $Window);

      var def = self._proto, $scope = self._scope;

      return (function($base, $super) {
        function $View(){};
        var self = $View = $klass($base, $super, 'View', $View);

        var def = self._proto, $scope = self._scope, $a, $b;

        def["native"] = nil;
        def.$initialize = function(window) {
          var self = this;

          self.window = window;
          return self["native"] = window.$to_n();
        };

        if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Window.innerSize")) !== nil && (!$a._isBoolean || $a == true))) {
          def.$width = function() {
            var self = this;

            return self["native"].innerWidth;
          };

          return (def.$height = function() {
            var self = this;

            return self["native"].innerHeight;
          }, nil) && 'height';
        } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Element.clientSize")) !== nil && (!$a._isBoolean || $a == true))) {
          def.$height = function() {
            var self = this;

            return self["native"].document.documentElement.clientHeight;
          };

          return (def.$width = function() {
            var self = this;

            return self["native"].document.documentElement.clientWidth;
          }, nil) && 'width';
          } else {
          def.$width = function() {
            var $a, self = this;

            return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "window size unsupported");
          };

          return (def.$height = function() {
            var $a, self = this;

            return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "window size unsupported");
          }, nil) && 'height';
        };
      })(self, null)
    })(self, null)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/window/view.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$to_n', '$[]', '$width', '$height', '$supports?', '$raise', '$set']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Window(){};
      var self = $Window = $klass($base, $super, 'Window', $Window);

      var def = self._proto, $scope = self._scope;

      return (function($base, $super) {
        function $Size(){};
        var self = $Size = $klass($base, $super, 'Size', $Size);

        var def = self._proto, $scope = self._scope, $a, $b;

        def["native"] = nil;
        def.$initialize = function(window) {
          var self = this;

          self.window = window;
          return self["native"] = window.$to_n();
        };

        def.$set = function(what) {
          var $a, self = this, width = nil, height = nil;

          width = ((($a = what['$[]']("width")) !== false && $a !== nil) ? $a : self.$width());
          height = ((($a = what['$[]']("height")) !== false && $a !== nil) ? $a : self.$height());
          self["native"].resizeTo(width, height);
          return self;
        };

        if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Window.outerSize")) !== nil && (!$a._isBoolean || $a == true))) {
          def.$width = function() {
            var self = this;

            return self["native"].outerWidth;
          };

          def.$height = function() {
            var self = this;

            return self["native"].outerHeight;
          };
          } else {
          def.$width = function() {
            var $a, self = this;

            return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "window outer size not supported");
          };

          def.$height = function() {
            var $a, self = this;

            return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "window outer size not supported");
          };
        };

        def['$width='] = function(value) {
          var self = this;

          return self.$set($hash2(["width"], {"width": value}));
        };

        return (def['$height='] = function(value) {
          var self = this;

          return self.$set($hash2(["height"], {"height": value}));
        }, nil) && 'height=';
      })(self, null)
    })(self, null)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/window/size.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$to_n', '$supports?', '$new', '$raise', '$x', '$position', '$y', '$[]']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Window(){};
      var self = $Window = $klass($base, $super, 'Window', $Window);

      var def = self._proto, $scope = self._scope;

      return (function($base, $super) {
        function $Scroll(){};
        var self = $Scroll = $klass($base, $super, 'Scroll', $Scroll);

        var def = self._proto, $scope = self._scope, $a, $b;

        def["native"] = nil;
        def.$initialize = function(window) {
          var self = this;

          self.window = window;
          return self["native"] = window.$to_n();
        };

        if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Window.scroll")) !== nil && (!$a._isBoolean || $a == true))) {
          def.$position = function() {
            var $a, self = this;

            
        var doc  = self["native"].document,
            root = doc.documentElement,
            body = doc.body;

        var x = root.scrollLeft || body.scrollLeft,
            y = root.scrollTop  || body.scrollTop;
      ;
            return (($a = $scope.Position) == null ? $opal.cm('Position') : $a).$new(x, y);
          }
        } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Window.pageOffset")) !== nil && (!$a._isBoolean || $a == true))) {
          def.$position = function() {
            var $a, self = this;

            return (($a = $scope.Position) == null ? $opal.cm('Position') : $a).$new(self["native"].pageXOffset, self["native"].pageYOffset);
          }
          } else {
          def.$position = function() {
            var $a, self = this;

            return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "window scroll unsupported");
          }
        };

        def.$x = function() {
          var self = this;

          return self.$position().$x();
        };

        def.$y = function() {
          var self = this;

          return self.$position().$y();
        };

        def.$to = function(what) {
          var $a, self = this, x = nil, y = nil;

          x = ((($a = what['$[]']("x")) !== false && $a !== nil) ? $a : self.$x());
          y = ((($a = what['$[]']("y")) !== false && $a !== nil) ? $a : self.$y());
          self["native"].scrollTo(x, y);
          return self;
        };

        return (def.$by = function(what) {
          var $a, self = this, x = nil, y = nil;

          x = ((($a = what['$[]']("x")) !== false && $a !== nil) ? $a : 0);
          y = ((($a = what['$[]']("y")) !== false && $a !== nil) ? $a : 0);
          self["native"].scrollBy(x, y);
          return self;
        }, nil) && 'by';
      })(self, null)
    })(self, null)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/window/scroll.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, $b, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2, $gvars = $opal.gvars;

  $opal.add_stubs(['$delete', '$join', '$map', '$===', '$new', '$include', '$[]', '$alert', '$prompt', '$confirm']);
  ;
  ;
  ;
  ;
  ;
  (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Window(){};
      var self = $Window = $klass($base, $super, 'Window', $Window);

      var def = self._proto, $scope = self._scope, $a;

      def["native"] = nil;
      $opal.defs(self, '$open', function(url, options) {
        var $a, $b, TMP_1, self = this, name = nil, features = nil;

        name = options.$delete("name");
        features = ($a = ($b = options).$map, $a._p = (TMP_1 = function(key, value){var self = TMP_1._s || this, $case = nil;
if (key == null) key = nil;if (value == null) value = nil;
        value = (function() {$case = value;if (true['$===']($case)) {return "yes"}else if (false['$===']($case)) {return "no"}else {return value}})();
          return "" + (key) + "=" + (value);}, TMP_1._s = self, TMP_1), $a).call($b).$join(",");
        
      var win = window.open(url, name, features);

      if (win == null) {
        return nil;
      }

      return self.$new(win);
    ;
      });

      self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

      def.$alert = function(value) {
        var self = this;

        self["native"].alert(value);
        return value;
      };

      def.$prompt = function(value) {
        var self = this;

        return self["native"].prompt(value) || nil;
      };

      def.$confirm = function(value) {
        var self = this;

        return self["native"].confirm(value) || false;
      };

      def.$view = function() {
        var $a, self = this;

        return (($a = $scope.View) == null ? $opal.cm('View') : $a).$new(self);
      };

      def.$size = function() {
        var $a, self = this;

        return (($a = $scope.Size) == null ? $opal.cm('Size') : $a).$new(self);
      };

      def.$scroll = function() {
        var $a, self = this;

        return (($a = $scope.Scroll) == null ? $opal.cm('Scroll') : $a).$new(self);
      };

      def['$send!'] = function(message, options) {
        var $a, self = this;

        if (options == null) {
          options = $hash2([], {})
        }
        return self["native"].postMessage(message, ((($a = options['$[]']("to")) !== false && $a !== nil) ? $a : "*"));
      };

      return (def.$close = function() {
        var self = this;

        
      return (window.open('', '_self', '') && window.close()) ||
             (window.opener = null && window.close()) ||
             (window.opener = '' && window.close());
    
      }, nil) && 'close';
    })(self, null)
    
  })(self);
  $gvars.window = (($a = ((($b = $scope.Browser) == null ? $opal.cm('Browser') : $b))._scope).Window == null ? $a.cm('Window') : $a.Window).$new(window);
  return (function($base) {
    var self = $module($base, 'Kernel');

    var def = self._proto, $scope = self._scope;

    def.$alert = function(value) {
      var self = this;
      if ($gvars.window == null) $gvars.window = nil;

      return $gvars.window.$alert(value);
    };

    def.$prompt = function(value) {
      var self = this;
      if ($gvars.window == null) $gvars.window = nil;

      return $gvars.window.$prompt(value);
    };

    def.$confirm = function(value) {
      var self = this;
      if ($gvars.window == null) $gvars.window = nil;

      return $gvars.window.$confirm(value);
    };
        ;$opal.donate(self, ["$alert", "$prompt", "$confirm"]);
  })(self);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/window.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$include', '$call', '$to_n', '$<<', '$converters', '$native?', '$each', '$instance_eval', '$register', '$to_proc', '$attr_reader', '$lambda', '$new', '$stopped?', '$arguments', '$!', '$prevented?', '$class_for', '$off', '$target', '$[]', '$delegated', '$delete', '$last', '$empty?', '$first', '$raise', '$name_for', '$handlers', '$[]=', '$include?', '$callback=', '$on!', '$delegate', '$on', '$handlers=', '$push', '$callbacks', '$attach', '$attach!', '$supports?', '$name', '$==', '$event', '$===', '$warn', '$detach', '$gsub', '$delete_if', '$=~', '$clear', '$none?', '$is_a?', '$create', '$dispatch', '$trigger', '$bubbles=', '$private', '$nil?', '$matches?', '$dup', '$on=', '$parent']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

        (function($base, $super) {
          function $Definition(){};
          var self = $Definition = $klass($base, $super, 'Definition', $Definition);

          var def = self._proto, $scope = self._scope, $a, TMP_1;

          def["native"] = nil;
          self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

          $opal.defs(self, '$new', TMP_1 = function() {
            var self = this, $iter = TMP_1._p, block = $iter || nil, data = nil;

            TMP_1._p = null;
            data = $opal.find_super_dispatcher(self, 'new', TMP_1, null, $Definition).apply(self, [{ bubbles: true, cancelable: true }]);
            if (block !== false && block !== nil) {
              block.$call(data)};
            return data.$to_n();
          });

          def['$bubbles='] = function(value) {
            var self = this;

            return self["native"].bubbles = value;
          };

          return (def['$cancelable='] = function(value) {
            var self = this;

            return self["native"].cancelable = value;
          }, nil) && 'cancelable=';
        })(self, null);

        return (function($base) {
          var self = $module($base, 'Target');

          var def = self._proto, $scope = self._scope, TMP_2, $a, TMP_8, TMP_11, $b, TMP_16, TMP_17;

          $opal.defs(self, '$converters', function() {
            var $a, self = this;
            if (self.converters == null) self.converters = nil;

            return ((($a = self.converters) !== false && $a !== nil) ? $a : self.converters = []);
          });

          $opal.defs(self, '$register', TMP_2 = function() {
            var self = this, $iter = TMP_2._p, block = $iter || nil;

            TMP_2._p = null;
            return self.$converters()['$<<'](block);
          });

          $opal.defs(self, '$convert', function(value) {try {

            var $a, $b, TMP_3, self = this;

            if ((($a = self['$native?'](value)) !== nil && (!$a._isBoolean || $a == true))) {
              } else {
              return value
            };
            ($a = ($b = self.$converters()).$each, $a._p = (TMP_3 = function(block){var self = TMP_3._s || this, $a, result = nil;
if (block == null) block = nil;
            if ((($a = result = block.$call(value)) !== nil && (!$a._isBoolean || $a == true))) {
                $opal.$return(result)
                } else {
                return nil
              }}, TMP_3._s = self, TMP_3), $a).call($b);
            return nil;
            } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
          });

          $opal.defs(self, '$included', function(klass) {
            var $a, $b, TMP_4, self = this;

            return ($a = ($b = klass).$instance_eval, $a._p = (TMP_4 = function(){var self = TMP_4._s || this, TMP_5;

            return ($opal.defs(self, '$target', TMP_5 = function() {
                var $a, $b, $c, $d, $e, self = this, $iter = TMP_5._p, block = $iter || nil;

                TMP_5._p = null;
                return ($a = ($b = (($c = ((($d = ((($e = $scope.DOM) == null ? $opal.cm('DOM') : $e))._scope).Event == null ? $d.cm('Event') : $d.Event))._scope).Target == null ? $c.cm('Target') : $c.Target)).$register, $a._p = block.$to_proc(), $a).call($b);
              }), nil) && 'target'}, TMP_4._s = self, TMP_4), $a).call($b);
          });

          (function($base, $super) {
            function $Callback(){};
            var self = $Callback = $klass($base, $super, 'Callback', $Callback);

            var def = self._proto, $scope = self._scope, TMP_6;

            def.proc = def.name = nil;
            self.$attr_reader("target", "name", "selector");

            def.$initialize = TMP_6 = function(target, name, selector) {
              var self = this, $iter = TMP_6._p, block = $iter || nil;

              if (selector == null) {
                selector = nil
              }
              TMP_6._p = null;
              self.target = target;
              self.name = name;
              self.selector = selector;
              return self.block = block;
            };

            def.$call = function(e) {
              var self = this;

              return self.$to_proc().$call(e);
            };

            def.$to_proc = function() {
              var $a, $b, $c, TMP_7, self = this;

              return ((($a = self.proc) !== false && $a !== nil) ? $a : self.proc = ($b = ($c = self).$lambda, $b._p = (TMP_7 = function(event){var self = TMP_7._s || this, $a;
                if (self.block == null) self.block = nil;
if (event == null) event = nil;
              
            if (!event.currentTarget) {
              event.currentTarget = self.target.native;
            }
          
                event = (($a = $scope.Event) == null ? $opal.cm('Event') : $a).$new(event, self);
                if ((($a = event['$stopped?']()) !== nil && (!$a._isBoolean || $a == true))) {
                  } else {
                  ($a = self.block).$call.apply($a, [event].concat(event.$arguments()))
                };
                return event['$prevented?']()['$!']();}, TMP_7._s = self, TMP_7), $b).call($c));
            };

            def.$event = function() {
              var $a, self = this;

              return (($a = $scope.Event) == null ? $opal.cm('Event') : $a).$class_for(self.name);
            };

            return (def.$off = function() {
              var self = this;

              return self.$target().$off(self);
            }, nil) && 'off';
          })(self, null);

          (function($base, $super) {
            function $Delegate(){};
            var self = $Delegate = $klass($base, $super, 'Delegate', $Delegate);

            var def = self._proto, $scope = self._scope;

            def.target = def.name = def.pair = nil;
            def.$initialize = function(target, name, pair) {
              var self = this;

              self.target = target;
              self.name = name;
              return self.pair = pair;
            };

            return (def.$off = function() {
              var $a, self = this, delegate = nil;

              delegate = self.target.$delegated()['$[]'](self.name);
              delegate.$last().$delete(self.pair);
              if ((($a = delegate.$last()['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
                delegate.$first().$off();
                return delegate.$delete(self.name);
                } else {
                return nil
              };
            }, nil) && 'off';
          })(self, null);

          $opal.cdecl($scope, 'Delegates', (($a = $scope.Struct) == null ? $opal.cm('Struct') : $a).$new("callback", "handlers"));

          def.$on = TMP_8 = function(name, selector) {
            var $a, $b, TMP_9, $c, TMP_10, $d, $e, self = this, $iter = TMP_8._p, block = $iter || nil, delegate = nil, pair = nil, callback = nil;

            if (selector == null) {
              selector = nil
            }
            TMP_8._p = null;
            if (block !== false && block !== nil) {
              } else {
              self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no block has been given")
            };
            name = (($a = $scope.Event) == null ? $opal.cm('Event') : $a).$name_for(name);
            if (selector !== false && selector !== nil) {
              if ((($a = delegate = self.$delegated()['$[]'](name)) !== nil && (!$a._isBoolean || $a == true))) {
                pair = [selector, block];
                delegate.$handlers()['$<<'](pair);
                return (($a = $scope.Delegate) == null ? $opal.cm('Delegate') : $a).$new(self, name, pair);
                } else {
                delegate = self.$delegated()['$[]='](name, (($a = $scope.Delegates) == null ? $opal.cm('Delegates') : $a).$new());
                if ((($a = ["blur", "focus"]['$include?'](name)) !== nil && (!$a._isBoolean || $a == true))) {
                  delegate['$callback='](($a = ($b = self)['$on!'], $a._p = (TMP_9 = function(e){var self = TMP_9._s || this;
if (e == null) e = nil;
                  return self.$delegate(delegate, e)}, TMP_9._s = self, TMP_9), $a).call($b, name))
                  } else {
                  delegate['$callback='](($a = ($c = self).$on, $a._p = (TMP_10 = function(e){var self = TMP_10._s || this;
if (e == null) e = nil;
                  return self.$delegate(delegate, e)}, TMP_10._s = self, TMP_10), $a).call($c, name))
                };
                pair = [selector, block];
                delegate['$handlers=']([pair]);
                return (($a = $scope.Delegate) == null ? $opal.cm('Delegate') : $a).$new(self, name, pair);
              }
              } else {
              callback = ($a = ($d = (($e = $scope.Callback) == null ? $opal.cm('Callback') : $e)).$new, $a._p = block.$to_proc(), $a).call($d, self, name, selector);
              self.$callbacks().$push(callback);
              return self.$attach(callback);
            };
          };

          def['$on!'] = TMP_11 = function(name) {
            var $a, $b, $c, self = this, $iter = TMP_11._p, block = $iter || nil, callback = nil;

            TMP_11._p = null;
            if (block !== false && block !== nil) {
              } else {
              self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no block has been given")
            };
            name = (($a = $scope.Event) == null ? $opal.cm('Event') : $a).$name_for(name);
            callback = ($a = ($b = (($c = $scope.Callback) == null ? $opal.cm('Callback') : $c)).$new, $a._p = block.$to_proc(), $a).call($b, self, name);
            self.$callbacks().$push(callback);
            return self['$attach!'](callback);
          };

          if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.addListener")) !== nil && (!$a._isBoolean || $a == true))) {
            def.$attach = function(callback) {
              var self = this;
              if (self["native"] == null) self["native"] = nil;

              self["native"].addEventListener(callback.$name(), callback.$to_proc());
              return callback;
            };

            def['$attach!'] = function(callback) {
              var self = this;
              if (self["native"] == null) self["native"] = nil;

              self["native"].addEventListener(callback.$name(), callback.$to_proc(), true);
              return callback;
            };
          } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.attach")) !== nil && (!$a._isBoolean || $a == true))) {
            def.$attach = function(callback) {
              var $a, self = this;
              if (self["native"] == null) self["native"] = nil;

              if (callback.$event()['$==']((($a = $scope.Custom) == null ? $opal.cm('Custom') : $a))) {
                
            if (!self["native"].$custom) {
              self["native"].$custom = function(event) {
                for (var i = 0, length = self["native"].$callbacks.length; i < length; i++) {
                  var callback = self["native"].$callbacks[i];

                  if ((callback).$event()['$==']((($a = $scope.Custom) == null ? $opal.cm('Custom') : $a))) {
                    event.type = callback.name;

                    (callback).$call(event);
                  }
                }
              };

              self["native"].attachEvent("ondataavailable", self["native"].$custom);
            }
          ;
                } else {
                self["native"].attachEvent("on" + callback.$name(), callback.$to_proc());
              };
              return callback;
            };

            def['$attach!'] = function(callback) {
              var self = this, $case = nil;
              if (self["native"] == null) self["native"] = nil;

              $case = callback.$name();if ("blur"['$===']($case)) {self["native"].attachEvent("onfocusout", callback.$to_proc());}else if ("focus"['$===']($case)) {self["native"].attachEvent("onfocusin", callback.$to_proc());}else {self.$warn("attach: capture doesn't work on this browser");
              self.$attach(callback);};
              return callback;
            };
            } else {
            def.$attach = function() {
              var $a, self = this;

              return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
            };

            def['$attach!'] = function() {
              var $a, self = this;

              return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
            };
          };

          def.$off = function(what) {
            var $a, $b, TMP_12, $c, TMP_13, $d, TMP_14, self = this, $case = nil;

            if (what == null) {
              what = nil
            }
            return (function() {$case = what;if ((($a = $scope.Callback) == null ? $opal.cm('Callback') : $a)['$===']($case)) {self.$callbacks().$delete(what);
            return self.$detach(what);}else if ((($a = $scope.String) == null ? $opal.cm('String') : $a)['$===']($case)) {if ((($a = ((($b = what['$include?']("*")) !== false && $b !== nil) ? $b : what['$include?']("?"))) !== nil && (!$a._isBoolean || $a == true))) {
              return self.$off((($a = $scope.Regexp) == null ? $opal.cm('Regexp') : $a).$new(what.$gsub(/\*/, ".*?").$gsub(/\?/, ".")))
              } else {
              what = (($a = $scope.Event) == null ? $opal.cm('Event') : $a).$name_for(what);
              return ($a = ($b = self.$callbacks()).$delete_if, $a._p = (TMP_12 = function(callback){var self = TMP_12._s || this;
if (callback == null) callback = nil;
              if (callback.$name()['$=='](what)) {
                  self.$detach(callback);
                  return true;
                  } else {
                  return nil
                }}, TMP_12._s = self, TMP_12), $a).call($b);
            }}else if ((($a = $scope.Regexp) == null ? $opal.cm('Regexp') : $a)['$===']($case)) {return ($a = ($c = self.$callbacks()).$delete_if, $a._p = (TMP_13 = function(callback){var self = TMP_13._s || this, $a;
if (callback == null) callback = nil;
            if ((($a = callback.$name()['$=~'](what)) !== nil && (!$a._isBoolean || $a == true))) {
                self.$detach(callback);
                return true;
                } else {
                return nil
              }}, TMP_13._s = self, TMP_13), $a).call($c)}else {($a = ($d = self.$callbacks()).$each, $a._p = (TMP_14 = function(callback){var self = TMP_14._s || this;
if (callback == null) callback = nil;
            return self.$detach(callback)}, TMP_14._s = self, TMP_14), $a).call($d);
            return self.$callbacks().$clear();}})();
          };

          if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.removeListener")) !== nil && (!$a._isBoolean || $a == true))) {
            def.$detach = function(callback) {
              var self = this;
              if (self["native"] == null) self["native"] = nil;

              return self["native"].removeEventListener(callback.$name(), callback.$to_proc(), false);
            }
          } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.detach")) !== nil && (!$a._isBoolean || $a == true))) {
            def.$detach = function(callback) {
              var $a, $b, $c, TMP_15, self = this;
              if (self["native"] == null) self["native"] = nil;

              if (callback.$event()['$==']((($a = $scope.Custom) == null ? $opal.cm('Custom') : $a))) {
                if ((($a = ($b = ($c = self.$callbacks())['$none?'], $b._p = (TMP_15 = function(c){var self = TMP_15._s || this, $a;
if (c == null) c = nil;
                return c.$event()['$==']((($a = $scope.Custom) == null ? $opal.cm('Custom') : $a))}, TMP_15._s = self, TMP_15), $b).call($c)) !== nil && (!$a._isBoolean || $a == true))) {
                  
              self["native"].detachEvent("ondataavailable", self["native"].$custom);

              delete self["native"].$custom;
            ;
                  } else {
                  return nil
                }
                } else {
                return self["native"].detachEvent("on" + callback.$name(), callback.$to_proc());
              };
            }
            } else {
            def.$detach = function(callback) {
              var $a, self = this;

              return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
            }
          };

          def.$trigger = TMP_16 = function(event, args) {
            var $a, $b, $c, self = this, $iter = TMP_16._p, block = $iter || nil;

            args = $slice.call(arguments, 1);
            TMP_16._p = null;
            if ((($a = event['$is_a?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
              event = ($a = ($b = (($c = $scope.Event) == null ? $opal.cm('Event') : $c)).$create, $a._p = block.$to_proc(), $a).apply($b, [event].concat(args))};
            return self.$dispatch(event);
          };

          def['$trigger!'] = TMP_17 = function(event, args) {
            var $a, $b, TMP_18, self = this, $iter = TMP_17._p, block = $iter || nil;

            args = $slice.call(arguments, 1);
            TMP_17._p = null;
            return ($a = ($b = self).$trigger, $a._p = (TMP_18 = function(e){var self = TMP_18._s || this;
if (e == null) e = nil;
            if (block !== false && block !== nil) {
                block.$call(e)};
              return e['$bubbles='](false);}, TMP_18._s = self, TMP_18), $a).apply($b, [event].concat(args));
          };

          if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.dispatch")) !== nil && (!$a._isBoolean || $a == true))) {
            def.$dispatch = function(event) {
              var self = this;
              if (self["native"] == null) self["native"] = nil;

              return self["native"].dispatchEvent(event.$to_n());
            }
          } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.fire")) !== nil && (!$a._isBoolean || $a == true))) {
            def.$dispatch = function(event) {
              var $a, $b, self = this;
              if (self["native"] == null) self["native"] = nil;

              if ((($a = (($b = $scope.Custom) == null ? $opal.cm('Custom') : $b)['$==='](event)) !== nil && (!$a._isBoolean || $a == true))) {
                return self["native"].fireEvent("ondataavailable", event.$to_n());
                } else {
                return self["native"].fireEvent("on" + event.$name(), event.$to_n());
              };
            }
            } else {
            def.$dispatch = function() {
              var $a, self = this;

              return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
            }
          };

          self.$private();

          def.$callbacks = function() {
            var self = this;
            if (self["native"] == null) self["native"] = nil;

            
        if (!self["native"].$callbacks) {
          self["native"].$callbacks = [];
        }

        return self["native"].$callbacks;
      ;
          };

          def.$delegated = function() {
            var self = this;
            if (self["native"] == null) self["native"] = nil;

            
        if (!self["native"].$delegated) {
          self["native"].$delegated = $hash2([], {});
        }

        return self["native"].$delegated;
      ;
          };

          def.$delegate = function(delegates, event, element) {
            var $a, $b, TMP_19, self = this;

            if (element == null) {
              element = event.$target()
            }
            if ((($a = ((($b = element['$nil?']()) !== false && $b !== nil) ? $b : element['$=='](event.$on()))) !== nil && (!$a._isBoolean || $a == true))) {
              return nil};
            ($a = ($b = delegates.$handlers()).$each, $a._p = (TMP_19 = function(selector, block){var self = TMP_19._s || this, $a, new$ = nil;
if (selector == null) selector = nil;if (block == null) block = nil;
            if ((($a = element['$matches?'](selector)) !== nil && (!$a._isBoolean || $a == true))) {
                new$ = event.$dup();
                new$['$on='](element);
                return ($a = block).$call.apply($a, [new$].concat(new$.$arguments()));
                } else {
                return nil
              }}, TMP_19._s = self, TMP_19), $a).call($b);
            return self.$delegate(delegates, event, element.$parent());
          };
                    ;$opal.donate(self, ["$on", "$on!", "$attach", "$attach!", "$attach", "$attach!", "$attach", "$attach!", "$off", "$detach", "$detach", "$detach", "$trigger", "$trigger!", "$dispatch", "$dispatch", "$dispatch", "$callbacks", "$delegated", "$delegate"]);
        })(self);
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/base.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $UI(){};
          var self = $UI = $klass($base, $super, 'UI', $UI);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.UI");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$detail='] = function(value) {
              var self = this;

              return self["native"].detail = value;
            };

            return (def['$view='] = function(value) {
              var self = this;

              return self["native"].view = value;
            }, nil) && 'view=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new UIEvent(name, desc);
              })
            } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                
        var event = document.createEvent("UIEvent");
            event.initUIEvent(name, desc.bubbles, desc.cancelable,
              desc.view || window, desc.detail || 0);

        return event;
      
              })}};

          self.$alias_native("detail");

          return self.$alias_native("view");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/ui.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$!', '$nil?', '$[]', '$include', '$new', '$try_convert', '$supported?', '$supports?', '$alias_native', '$x', '$screen', '$y', '$DOM', '$==', '$downcase', '$name']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Mouse(){};
          var self = $Mouse = $klass($base, $super, 'Mouse', $Mouse);

          var def = self._proto, $scope = self._scope, $a, $b;

          def["native"] = nil;
          $opal.defs(self, '$supported?', function() {
            var self = this;
            if ($gvars.$ == null) $gvars.$ = nil;

            return $gvars.$['$[]']("MouseEvent")['$nil?']()['$!']();
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            (function($base, $super) {
              function $Client(){};
              var self = $Client = $klass($base, $super, 'Client', $Client);

              var def = self._proto, $scope = self._scope, $a;

              def["native"] = nil;
              self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

              def['$x='] = function(value) {
                var self = this;

                return self["native"].clientX = value;
              };

              return (def['$y='] = function(value) {
                var self = this;

                return self["native"].clientY = value;
              }, nil) && 'y=';
            })(self, null);

            (function($base, $super) {
              function $Layer(){};
              var self = $Layer = $klass($base, $super, 'Layer', $Layer);

              var def = self._proto, $scope = self._scope, $a;

              def["native"] = nil;
              self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

              def['$x='] = function(value) {
                var self = this;

                return self["native"].layerX = value;
              };

              return (def['$y='] = function(value) {
                var self = this;

                return self["native"].layerY = value;
              }, nil) && 'y=';
            })(self, null);

            (function($base, $super) {
              function $Offset(){};
              var self = $Offset = $klass($base, $super, 'Offset', $Offset);

              var def = self._proto, $scope = self._scope, $a;

              def["native"] = nil;
              self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

              def['$x='] = function(value) {
                var self = this;

                return self["native"].offsetX = value;
              };

              return (def['$y='] = function(value) {
                var self = this;

                return self["native"].offsetY= value;
              }, nil) && 'y=';
            })(self, null);

            (function($base, $super) {
              function $Page(){};
              var self = $Page = $klass($base, $super, 'Page', $Page);

              var def = self._proto, $scope = self._scope, $a;

              def["native"] = nil;
              self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

              def['$x='] = function(value) {
                var self = this;

                return self["native"].pageX = value;
              };

              return (def['$y='] = function(value) {
                var self = this;

                return self["native"].pageY = value;
              }, nil) && 'y=';
            })(self, null);

            (function($base, $super) {
              function $Screen(){};
              var self = $Screen = $klass($base, $super, 'Screen', $Screen);

              var def = self._proto, $scope = self._scope, $a;

              def["native"] = nil;
              self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

              def['$x='] = function(value) {
                var self = this;

                return self["native"].screenX = value;
              };

              return (def['$y='] = function(value) {
                var self = this;

                return self["native"].screenY = value;
              }, nil) && 'y=';
            })(self, null);

            (function($base, $super) {
              function $Ancestor(){};
              var self = $Ancestor = $klass($base, $super, 'Ancestor', $Ancestor);

              var def = self._proto, $scope = self._scope, $a;

              def["native"] = nil;
              self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

              def['$x='] = function(value) {
                var self = this;

                return self["native"].x = value;
              };

              return (def['$y='] = function(value) {
                var self = this;

                return self["native"].y = value;
              }, nil) && 'y=';
            })(self, null);

            def['$x='] = function(value) {
              var self = this;

              return self["native"].screenX = value;
            };

            def['$y='] = function(value) {
              var self = this;

              return self["native"].screenY = value;
            };

            def['$alt!'] = function() {
              var self = this;

              return self["native"].altKey = true;
            };

            def['$ctrl!'] = function() {
              var self = this;

              return self["native"].ctrlKey = true;
            };

            def['$meta!'] = function() {
              var self = this;

              return self["native"].metaKey = true;
            };

            def['$button='] = function(value) {
              var self = this;

              return self["native"].button = value;
            };

            def.$client = function() {
              var $a, self = this;

              return (($a = $scope.Client) == null ? $opal.cm('Client') : $a).$new(self["native"]);
            };

            def.$layer = function() {
              var $a, self = this;

              return (($a = $scope.Layer) == null ? $opal.cm('Layer') : $a).$new(self["native"]);
            };

            def.$offset = function() {
              var $a, self = this;

              return (($a = $scope.Offset) == null ? $opal.cm('Offset') : $a).$new(self["native"]);
            };

            def.$page = function() {
              var $a, self = this;

              return (($a = $scope.Page) == null ? $opal.cm('Page') : $a).$new(self["native"]);
            };

            def.$screen = function() {
              var $a, self = this;

              return (($a = $scope.Screen) == null ? $opal.cm('Screen') : $a).$new(self["native"]);
            };

            def.$ancestor = function() {
              var $a, self = this;

              return (($a = $scope.Ancestor) == null ? $opal.cm('Ancestor') : $a).$new(self["native"]);
            };

            def['$related='] = function(elem) {
              var $a, self = this;

              return self["native"].relatedTarget = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$try_convert(elem);
            };

            def['$from='] = function(elem) {
              var $a, self = this;

              return self["native"].fromElement = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$try_convert(elem);
            };

            return (def['$to='] = function(elem) {
              var $a, self = this;

              return self["native"].toElement = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$try_convert(elem);
            }, nil) && 'to=';
          })(self, (($a = ((($b = $scope.UI) == null ? $opal.cm('UI') : $b))._scope).Definition == null ? $a.cm('Definition') : $a.Definition));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new MouseEvent(name, desc);
              })
            } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                
        var event = document.createEvent("MouseEvent");
            event.initMouseEvent(name, desc.bubbles, desc.cancelable,
              desc.view || window, desc.detail || 0,
              desc.screenX || 0, desc.screenY || 0,
              desc.clientX || 0, desc.clientY || 0,
              desc.ctrlKey || false, desc.altKey || false,
              desc.shiftKey || false, desc.metaKey || false,
              desc.button || 0, desc.relatedTarget || null);

        return event;
      
              })}};

          self.$alias_native("alt?", "altKey");

          self.$alias_native("ctrl?", "ctrlKey");

          self.$alias_native("meta?", "metaKey");

          self.$alias_native("shift?", "shiftKey");

          self.$alias_native("button");

          def.$client = function() {
            var $a, self = this;

            return (($a = $scope.Position) == null ? $opal.cm('Position') : $a).$new(self["native"].clientX, self["native"].clientY);
          };

          def.$layer = function() {
            var $a, self = this;

            if ((($a = self["native"].layerX == null) !== nil && (!$a._isBoolean || $a == true))) {
              return nil
              } else {
              return (($a = $scope.Position) == null ? $opal.cm('Position') : $a).$new(self["native"].layerX, self["native"].layerY)
            };
          };

          def.$offset = function() {
            var $a, self = this;

            if ((($a = self["native"].offsetX == null) !== nil && (!$a._isBoolean || $a == true))) {
              return nil
              } else {
              return (($a = $scope.Position) == null ? $opal.cm('Position') : $a).$new(self["native"].offsetX, self["native"].offsetY)
            };
          };

          def.$page = function() {
            var $a, self = this;

            if ((($a = self["native"].pageX == null) !== nil && (!$a._isBoolean || $a == true))) {
              return nil
              } else {
              return (($a = $scope.Position) == null ? $opal.cm('Position') : $a).$new(self["native"].pageX, self["native"].pageY)
            };
          };

          def.$screen = function() {
            var $a, self = this;

            if ((($a = self["native"].screenX == null) !== nil && (!$a._isBoolean || $a == true))) {
              return nil
              } else {
              return (($a = $scope.Position) == null ? $opal.cm('Position') : $a).$new(self["native"].screenX, self["native"].screenY)
            };
          };

          def.$ancestor = function() {
            var $a, self = this;

            if ((($a = self["native"].x == null) !== nil && (!$a._isBoolean || $a == true))) {
              return nil
              } else {
              return (($a = $scope.Position) == null ? $opal.cm('Position') : $a).$new(self["native"].x, self["native"].y)
            };
          };

          def.$x = function() {
            var self = this;

            return self.$screen().$x();
          };

          def.$y = function() {
            var self = this;

            return self.$screen().$y();
          };

          def.$related = function() {
            var $a, self = this;

            if ((($a = self["native"].relatedTarget == null) !== nil && (!$a._isBoolean || $a == true))) {
              return nil
              } else {
              return self.$DOM(self["native"].relatedTarget)
            };
          };

          def.$from = function() {
            var $a, self = this;

            if ((($a = self["native"].fromElement == null) !== nil && (!$a._isBoolean || $a == true))) {
              return nil
              } else {
              return self.$DOM(self["native"].fromElement)
            };
          };

          def.$to = function() {
            var $a, self = this;

            if ((($a = self["native"].toElement == null) !== nil && (!$a._isBoolean || $a == true))) {
              return nil
              } else {
              return self.$DOM(self["native"].toElement)
            };
          };

          def['$click?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("click");
          };

          def['$double_click?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("dblclick");
          };

          def['$down?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("mousedown");
          };

          def['$enter?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("mouseenter");
          };

          def['$leave?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("mouseleave");
          };

          def['$move?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("mousemove");
          };

          def['$out?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("mouseout");
          };

          def['$over?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("mouseover");
          };

          def['$up?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("mouseup");
          };

          return (def['$show?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("show");
          }, nil) && 'show?';
        })(self, (($a = $scope.UI) == null ? $opal.cm('UI') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/mouse.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native', '$code', '$chr', '$==', '$downcase', '$name']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Keyboard(){};
          var self = $Keyboard = $klass($base, $super, 'Keyboard', $Keyboard);

          var def = self._proto, $scope = self._scope, $a, $b;

          def["native"] = nil;
          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Keyboard");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$alt!'] = function() {
              var self = this;

              return self["native"].altKey = true;
            };

            def['$ctrl!'] = function() {
              var self = this;

              return self["native"].ctrlKey = true;
            };

            def['$meta!'] = function() {
              var self = this;

              return self["native"].metaKey = true;
            };

            def['$shift!'] = function() {
              var self = this;

              return self["native"].shiftKey = true;
            };

            def['$code='] = function(code) {
              var self = this;

              return self["native"].keyCode = self["native"].which = code;
            };

            def['$key='] = function(key) {
              var self = this;

              return self["native"].key = key;
            };

            def['$char='] = function(char$) {
              var self = this;

              return self["native"].char = self["native"].charCode = char$;
            };

            def['$repeat!'] = function() {
              var self = this;

              return self["native"].repeat = true;
            };

            return (def['$locale='] = function(value) {
              var self = this;

              return self["native"].locale = value;
            }, nil) && 'locale=';
          })(self, (($a = ((($b = $scope.UI) == null ? $opal.cm('UI') : $b))._scope).Definition == null ? $a.cm('Definition') : $a.Definition));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new KeyboardEvent(name, desc);
              })
            } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                
        var modifiers = "";

        if (desc.altKey) {
          modifiers += "Alt ";
        }

        if (desc.ctrlKey) {
          modifiers += "Ctrl ";
        }

        if (desc.shiftKey) {
          modifiers += "Shift" ;
        }

        if (desc.metaKey) {
          modifiers += "Meta ";
        }

        var event = document.createEvent("KeyboardEvent");
            event.initKeyboardEvent(name, desc.bubbles, desc.cancelable,
              desc.view || window, desc.which, 0,
              modifiers, desc.repeat, desc.locale);

        return event;
      
              })}};

          self.$alias_native("alt?", "altKey");

          self.$alias_native("ctrl?", "ctrlKey");

          self.$alias_native("meta?", "metaKey");

          self.$alias_native("shift?", "shiftKey");

          self.$alias_native("locale");

          self.$alias_native("repeat?", "repeat");

          def.$key = function() {
            var self = this;

            return self["native"].key || self["native"].keyIdentifier || nil;
          };

          def.$code = function() {
            var self = this;

            return self["native"].keyCode || self["native"].which || nil;
          };

          def.$char = function() {
            var $a, self = this;

            return self["native"].char || self["native"].charCode || (function() {if ((($a = self.$code()) !== nil && (!$a._isBoolean || $a == true))) {
              return self.$code().$chr()
              } else {
              return nil
            }; return nil; })();
          };

          $opal.defn(self, '$to_i', def.$key);

          def['$down?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("keydown");
          };

          def['$press?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("keypress");
          };

          return (def['$up?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("keyup");
          }, nil) && 'up?';
        })(self, (($a = $scope.UI) == null ? $opal.cm('UI') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/keyboard.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$convert', '$supported?', '$DOM']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Focus(){};
          var self = $Focus = $klass($base, $super, 'Focus', $Focus);

          var def = self._proto, $scope = self._scope, $a, $b;

          def["native"] = nil;
          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Focus");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$view='] = function(value) {
              var $a, self = this;

              return self["native"].view = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(value);
            };

            return (def['$related='] = function(elem) {
              var $a, self = this;

              return self["native"].relatedTarget = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(elem);
            }, nil) && 'related=';
          })(self, (($a = ((($b = $scope.UI) == null ? $opal.cm('UI') : $b))._scope).Definition == null ? $a.cm('Definition') : $a.Definition));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new FocusEvent(name, desc);
              })
            } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                
        var event = document.createEvent("FocusEvent");
            event.initFocusEvent(name, desc.bubbles, desc.cancelable,
              desc.view || window, 0, desc.relatedTarget);

        return event;
      
              })}};

          return (def.$related = function() {
            var self = this;

            return self.$DOM(self["native"].relatedTarget);
          }, nil) && 'related';
        })(self, (($a = $scope.UI) == null ? $opal.cm('UI') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/focus.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$!', '$nil?', '$[]', '$===', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Wheel(){};
          var self = $Wheel = $klass($base, $super, 'Wheel', $Wheel);

          var def = self._proto, $scope = self._scope, $a;

          def["native"] = nil;
          $opal.defs(self, '$supported?', function() {
            var self = this;
            if ($gvars.$ == null) $gvars.$ = nil;

            return $gvars.$['$[]']("WheelEvent")['$nil?']()['$!']();
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$x='] = function(value) {
              var self = this;

              return self["native"].deltaX = value;
            };

            def['$y='] = function(value) {
              var self = this;

              return self["native"].deltaY = value;
            };

            def['$z='] = function(value) {
              var self = this;

              return self["native"].deltaZ = value;
            };

            return (def['$mode='] = function(value) {
              var self = this, $case = nil;

              value = (function() {$case = value;if ("pixel"['$===']($case)) {return WheelEvent.DOM_DELTA_PIXEL;}else if ("line"['$===']($case)) {return WheelEvent.DOM_DELTA_LINE;}else if ("page"['$===']($case)) {return WheelEvent.DOM_DELTA_PAGE;}else { return nil }})();
              return self["native"].deltaMode = value;
            }, nil) && 'mode=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          $opal.defs(self, '$construct', function(name, desc) {
            var self = this;

            return new WheelEvent(name, desc);
          });

          self.$alias_native("x", "deltaX");

          self.$alias_native("y", "deltaY");

          self.$alias_native("z", "deltaZ");

          return (def.$mode = function() {
            var self = this, $case = nil;

            return (function() {$case = self["native"].deltaMode;if ((WheelEvent.DOM_DELTA_PIXEL)['$===']($case)) {return "pixel"}else if ((WheelEvent.DOM_DELTA_LINE)['$===']($case)) {return "line"}else if ((WheelEvent.DOM_DELTA_PAGE)['$===']($case)) {return "page"}else { return nil }})();
          }, nil) && 'mode';
        })(self, (($a = $scope.UI) == null ? $opal.cm('UI') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/wheel.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native', '$==', '$downcase', '$name']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Composition(){};
          var self = $Composition = $klass($base, $super, 'Composition', $Composition);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Composition");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$data='] = function(value) {
              var self = this;

              return self["native"].data = value;
            };

            return (def['$locale='] = function(value) {
              var self = this;

              return self["native"].locale = value;
            }, nil) && 'locale=';
          })(self, (($a = ((($b = $scope.UI) == null ? $opal.cm('UI') : $b))._scope).Definition == null ? $a.cm('Definition') : $a.Definition));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new CompositionEvent(name, desc);
              })
            } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                
        var event = document.createEvent("CompositionEvent");
            event.initCompositionEvent(name, desc.bubbles, desc.cancelable,
              desc.view || window, desc.data, desc.locale);

        return event;
      
              })}};

          self.$alias_native("data");

          self.$alias_native("locale");

          def['$start?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("compositionstart");
          };

          def['$update?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("compositionupdate");
          };

          return (def['$end?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("compositionend");
          }, nil) && 'end?';
        })(self, (($a = $scope.UI) == null ? $opal.cm('UI') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/composition.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Animation(){};
          var self = $Animation = $klass($base, $super, 'Animation', $Animation);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Animation");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$animation='] = function(value) {
              var self = this;

              return self["native"].animationName = value;
            };

            return (def['$elapsed='] = function(value) {
              var self = this;

              return self["native"].elapsedTime = value;
            }, nil) && 'elapsed=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new AnimationEvent(name, desc);
              })
            } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                
        var event = document.createEvent("AnimationEvent");
            event.initAnimationEvent(name, desc.bubbles, desc.cancelable,
              desc.animationName, desc.elapsedTime);

        return event;
      
              })}};

          self.$alias_native("name", "animationName");

          return self.$alias_native("elapsed", "elapsedTime");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/animation.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $AudioProcessing(){};
          var self = $AudioProcessing = $klass($base, $super, 'AudioProcessing', $AudioProcessing);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.AudioProcessing");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$time='] = function(value) {
              var self = this;

              return self["native"].playbackTime = value;
            };

            def['$input='] = function(value) {
              var self = this;

              return self["native"].inputBuffer = value;
            };

            return (def['$output='] = function(value) {
              var self = this;

              return self["native"].outputBuffer = value;
            }, nil) && 'output=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new AudioProcessingEvent(name, desc);
              })}};

          self.$alias_native("time", "playbackTime");

          self.$alias_native("input", "inputBuffer");

          return self.$alias_native("output", "outputBuffer");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/audio_processing.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $BeforeUnload(){};
          var self = $BeforeUnload = $klass($base, $super, 'BeforeUnload', $BeforeUnload);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.BeforeUnload");
          });

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              return ($opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new BeforeUnloadEvent(name, desc);
              }), nil) && 'construct'
              } else {
              return nil
            }
            } else {
            return nil
          };
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/before_unload.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Clipboard(){};
          var self = $Clipboard = $klass($base, $super, 'Clipboard', $Clipboard);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Clipboard");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$data='] = function(value) {
              var self = this;

              return self["native"].data = value;
            };

            return (def['$type='] = function(value) {
              var self = this;

              return self["native"].dataType = value;
            }, nil) && 'type=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new ClipboardEvent(name, desc);
              })}};

          self.$alias_native("data");

          return self.$alias_native("type", "dataType");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/clipboard.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $DeviceLight(){};
          var self = $DeviceLight = $klass($base, $super, 'DeviceLight', $DeviceLight);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.DeviceLight");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            return (def['$value='] = function(value) {
              var self = this;

              return self["native"].value = value;
            }, nil) && 'value='
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new DeviceLightEvent(name, desc);
              })}};

          return self.$alias_native("value");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/device_light.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$new', '$to_n', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $DeviceMotion(){};
          var self = $DeviceMotion = $klass($base, $super, 'DeviceMotion', $DeviceMotion);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.DeviceMotion");
          });

          $opal.cdecl($scope, 'Acceleration', (($a = $scope.Struct) == null ? $opal.cm('Struct') : $a).$new("x", "y", "z"));

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$acceleration='] = function(value) {
              var self = this;

              return self["native"].acceleration = value.$to_n();
            };

            def['$acceleration_with_gravity='] = function(value) {
              var self = this;

              return self["native"].accelerationIncludingGravity = value.$to_n();
            };

            def['$rotation='] = function(value) {
              var self = this;

              return self["native"].rotationRate = value;
            };

            return (def['$interval='] = function(value) {
              var self = this;

              return self["native"].interval = value;
            }, nil) && 'interval=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new DeviceMotionEvent(name, desc);
              })
            } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                
        var event = document.createEvent("DeviceMotionEvent");
            event.initDeviceMotionEvent(name, desc.bubbles, desc.cancelable,
              desc.acceleration, desc.accelerationIncludingGravity,
              desc.rotationRate, desc.interval);

        return event;
      
              })}};

          self.$alias_native("acceleration");

          self.$alias_native("acceleration_with_gravity", "accelerationIncludingGravity");

          self.$alias_native("rotation", "rotationRate");

          return self.$alias_native("interval");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/device_motion.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $DeviceOrientation(){};
          var self = $DeviceOrientation = $klass($base, $super, 'DeviceOrientation', $DeviceOrientation);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.DeviceOrientation");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$absolute='] = function(value) {
              var self = this;

              return self["native"].absolute = value;
            };

            def['$alpha='] = function(value) {
              var self = this;

              return self["native"].alpha = value;
            };

            def['$beta='] = function(value) {
              var self = this;

              return self["native"].beta = value;
            };

            return (def['$gamma='] = function(value) {
              var self = this;

              return self["native"].gamma = value;
            }, nil) && 'gamma=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new DeviceOrientationEvent(name, desc);
              })
            } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                
        var event = document.createEvent("DeviceOrientationEvent");
            event.initDeviceOrientationEvent(name, desc.bubbles, desc.cancelable,
              desc.alpha, desc.beta, desc.gamma, desc.absolute);

        return event;
      
              })}};

          self.$alias_native("absolute");

          self.$alias_native("alpha");

          self.$alias_native("beta");

          return self.$alias_native("gamma");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/device_orientation.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $DeviceProximity(){};
          var self = $DeviceProximity = $klass($base, $super, 'DeviceProximity', $DeviceProximity);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.DeviceProximity");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$value='] = function(value) {
              var self = this;

              return self["native"].value = value;
            };

            def['$min='] = function(value) {
              var self = this;

              return self["native"].min = value;
            };

            return (def['$max='] = function(value) {
              var self = this;

              return self["native"].max = value;
            }, nil) && 'max=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new DeviceProximityEvent(name, desc);
              })}};

          self.$alias_native("value");

          self.$alias_native("min");

          return self.$alias_native("max");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/device_proximity.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$include', '$new', '$convert', '$elem', '$supported?', '$alias_native', '$x', '$screen', '$y', '$DOM', '$raise']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Drag(){};
          var self = $Drag = $klass($base, $super, 'Drag', $Drag);

          var def = self._proto, $scope = self._scope, $a, $b;

          def["native"] = nil;
          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Drag");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            (function($base, $super) {
              function $Client(){};
              var self = $Client = $klass($base, $super, 'Client', $Client);

              var def = self._proto, $scope = self._scope, $a;

              def["native"] = nil;
              self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

              def['$x='] = function(value) {
                var self = this;

                return self["native"].clientX = value;
              };

              return (def['$y='] = function(value) {
                var self = this;

                return self["native"].clientY = value;
              }, nil) && 'y=';
            })(self, null);

            (function($base, $super) {
              function $Screen(){};
              var self = $Screen = $klass($base, $super, 'Screen', $Screen);

              var def = self._proto, $scope = self._scope, $a;

              def["native"] = nil;
              self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

              def['$x='] = function(value) {
                var self = this;

                return self["native"].screenX = value;
              };

              return (def['$y='] = function(value) {
                var self = this;

                return self["native"].screenY = value;
              }, nil) && 'y=';
            })(self, null);

            def['$alt!'] = function() {
              var self = this;

              return self["native"].altKey = true;
            };

            def['$ctrl!'] = function() {
              var self = this;

              return self["native"].ctrlKey = true;
            };

            def['$meta!'] = function() {
              var self = this;

              return self["native"].metaKey = true;
            };

            def['$button='] = function(value) {
              var self = this;

              return self["native"].button = value;
            };

            def.$client = function() {
              var $a, self = this;

              return (($a = $scope.Client) == null ? $opal.cm('Client') : $a).$new(self["native"]);
            };

            def.$screen = function() {
              var $a, self = this;

              return (($a = $scope.Screen) == null ? $opal.cm('Screen') : $a).$new(self["native"]);
            };

            def['$related='] = function(elem) {
              var $a, self = this;

              return self["native"].relatedTarget = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(elem);
            };

            return (def['$transfer='] = function(value) {
              var $a, self = this;

              return self["native"].dataTransfer = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(self.$elem());
            }, nil) && 'transfer=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new DragEvent(name, desc);
              })
            } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                
        var event = document.createEvent("DragEvent");
            event.initDragEvent(name, desc.bubbles, desc.cancelable,
              desc.view || window, 0,
              desc.screenX || 0, desc.screenY || 0,
              desc.clientX || 0, desc.clientY || 0,
              desc.ctrlKey, desc.altKey, desc.shiftKey, desc.metaKey,
              desc.button || 0, desc.relatedTarget, desc.dataTransfer);

        return event;
      
              })}};

          self.$alias_native("alt?", "altKey");

          self.$alias_native("ctrl?", "ctrlKey");

          self.$alias_native("meta?", "metaKey");

          self.$alias_native("shift?", "shiftKey");

          self.$alias_native("button");

          def.$client = function() {
            var $a, self = this;

            return (($a = $scope.Position) == null ? $opal.cm('Position') : $a).$new(self["native"].clientX, self["native"].clientY);
          };

          def.$screen = function() {
            var $a, self = this;

            if ((($a = (typeof(self["native"].screenX) !== "undefined")) !== nil && (!$a._isBoolean || $a == true))) {
              return (($a = $scope.Position) == null ? $opal.cm('Position') : $a).$new(self["native"].screenX, self["native"].screenY)
              } else {
              return nil
            };
          };

          def.$x = function() {
            var self = this;

            return self.$screen().$x();
          };

          def.$y = function() {
            var self = this;

            return self.$screen().$y();
          };

          def.$related = function() {
            var self = this;

            return self.$DOM(self["native"].relatedTarget);
          };

          return (def.$transfer = function() {
            var $a, self = this;

            return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
          }, nil) && 'transfer';
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/drag.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Gamepad(){};
          var self = $Gamepad = $klass($base, $super, 'Gamepad', $Gamepad);

          var def = self._proto, $scope = self._scope, $a, $b;

          def["native"] = nil;
          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Gamepad");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$id='] = function(value) {
              var self = this;

              return self["native"].id = value;
            };

            def['$index='] = function(value) {
              var self = this;

              return self["native"].index = value;
            };

            def['$at='] = function(value) {
              var self = this;

              return self["native"].timestamp = value;
            };

            def['$axes='] = function(value) {
              var self = this;

              return self["native"].axes = value;
            };

            return (def['$buttons='] = function(value) {
              var self = this;

              return self["native"].buttons = value;
            }, nil) && 'buttons=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new GamepadEvent(name, {
        bubbles:    desc.bubbles,
        cancelable: desc.cancelable,
        gamepad:    desc });
              })}};

          def.$id = function() {
            var self = this;

            return self["native"].gamepad.id;
          };

          def.$index = function() {
            var self = this;

            return self["native"].gamepad.index;
          };

          def.$at = function() {
            var self = this;

            return self["native"].gamepad.timestamp;
          };

          def.$axes = function() {
            var self = this;

            return self["native"].gamepad.axes;
          };

          return (def.$buttons = function() {
            var self = this;

            return self["native"].gamepad.buttons;
          }, nil) && 'buttons';
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/gamepad.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $HashChange(){};
          var self = $HashChange = $klass($base, $super, 'HashChange', $HashChange);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.HashChange");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$old='] = function(value) {
              var self = this;

              return self["native"].oldURL = value;
            };

            return (def['$new='] = function(value) {
              var self = this;

              return self["native"].newURL = value;
            }, nil) && 'new=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new HashChangeEvent(name, desc);
              })}};

          self.$alias_native("old", "oldURL");

          return self.$alias_native("new", "newURL");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/hash_change.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Progress(){};
          var self = $Progress = $klass($base, $super, 'Progress', $Progress);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Progress");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$computable='] = function(value) {
              var self = this;

              return self["native"].computableLength = value;
            };

            def['$loaded='] = function(value) {
              var self = this;

              return self["native"].loaded = value;
            };

            return (def['$total='] = function(value) {
              var self = this;

              return self["native"].total = value;
            }, nil) && 'total=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new ProgressEvent(name, desc);
              })
            } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                
        var event = document.createEvent("ProgressEvent");
            event.initProgressEvent(name, desc.bubbles, desc.cancelable,
              desc.computable, desc.loaded, desc.total);

        return event;
      
              })}};

          self.$alias_native("computable?", "computableLength");

          self.$alias_native("loaded");

          return self.$alias_native("total");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/progress.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $PageTransition(){};
          var self = $PageTransition = $klass($base, $super, 'PageTransition', $PageTransition);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.PageTransition");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            return (def['$persisted='] = function(value) {
              var self = this;

              return self["native"].persisted = value;
            }, nil) && 'persisted='
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.PageTransition")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new PageTransitionEvent(name, desc);
              })}};

          return self.$alias_native("persisted?", "persisted");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/page_transition.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $PopState(){};
          var self = $PopState = $klass($base, $super, 'PopState', $PopState);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.PopState");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            return (def['$state='] = function(value) {
              var self = this;

              return self["native"].state = value;
            }, nil) && 'state='
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new PopStateEvent(name, desc);
              })
            } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                
        var event = document.createEvent('PopStateEvent');
            event.initPopStateEvent(name, desc.bubbles, desc.cancelable,
              desc.state);

        return event;
      
              })}};

          return self.$alias_native("state");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/pop_state.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Storage(){};
          var self = $Storage = $klass($base, $super, 'Storage', $Storage);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Storage");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$key='] = function(value) {
              var self = this;

              return self["native"].key = value;
            };

            def['$new='] = function(value) {
              var self = this;

              return self["native"].newValue = value;
            };

            def['$old='] = function(value) {
              var self = this;

              return self["native"].oldValue = value;
            };

            def['$area='] = function(value) {
              var self = this;

              return self["native"].storageArea = value;
            };

            return (def['$url='] = function(value) {
              var self = this;

              return self["native"].url = value;
            }, nil) && 'url=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new StorageEvent(name, desc);
              })}};

          self.$alias_native("key");

          self.$alias_native("new", "newValue");

          self.$alias_native("old", "oldValue");

          self.$alias_native("area", "storageArea");

          return self.$alias_native("url");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/storage.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native', '$==', '$downcase', '$name']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Touch(){};
          var self = $Touch = $klass($base, $super, 'Touch', $Touch);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Touch");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$alt!'] = function() {
              var self = this;

              return self["native"].altKey = true;
            };

            def['$ctrl!'] = function() {
              var self = this;

              return self["native"].ctrlKey = true;
            };

            def['$meta!'] = function() {
              var self = this;

              return self["native"].metaKey = true;
            };

            return (def['$shift!'] = function() {
              var self = this;

              return self["native"].shiftKey = true;
            }, nil) && 'shift!';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new TouchEvent(name, desc);
              })}};

          self.$alias_native("alt?", "altKey");

          self.$alias_native("ctrl?", "ctrlKey");

          self.$alias_native("meta?", "metaKey");

          self.$alias_native("shift?", "shiftKey");

          def['$cancel?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("touchcancel");
          };

          def['$end?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("touchend");
          };

          def['$leave?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("touchleave");
          };

          def['$move?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("touchmove");
          };

          return (def['$start?'] = function() {
            var self = this;

            return self.$name().$downcase()['$==']("touchstart");
          }, nil) && 'start?';
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/touch.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Sensor(){};
          var self = $Sensor = $klass($base, $super, 'Sensor', $Sensor);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Sensor");
          });

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              return ($opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new SensorEvent(name, desc);
              }), nil) && 'construct'
              } else {
              return nil
            }
            } else {
            return nil
          };
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/sensor.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2, $range = $opal.range;

  $opal.add_stubs(['$each_pair', '$[]=', '$to_sym', '$[]', '$end_with?', '$enum_for', '$is_a?', '$==', '$instance_variable_get', '$===', '$eql?', '$dup', '$to_n', '$hash', '$class', '$join', '$map', '$inspect']);
  return (function($base, $super) {
    function $OpenStruct(){};
    var self = $OpenStruct = $klass($base, $super, 'OpenStruct', $OpenStruct);

    var def = self._proto, $scope = self._scope, TMP_2;

    def.table = nil;
    def.$initialize = function(hash) {
      var $a, $b, TMP_1, self = this;

      if (hash == null) {
        hash = nil
      }
      self.table = $hash2([], {});
      if (hash !== false && hash !== nil) {
        return ($a = ($b = hash).$each_pair, $a._p = (TMP_1 = function(key, value){var self = TMP_1._s || this;
          if (self.table == null) self.table = nil;
if (key == null) key = nil;if (value == null) value = nil;
        return self.table['$[]='](key.$to_sym(), value)}, TMP_1._s = self, TMP_1), $a).call($b)
        } else {
        return nil
      };
    };

    def['$[]'] = function(name) {
      var self = this;

      return self.table['$[]'](name.$to_sym());
    };

    def['$[]='] = function(name, value) {
      var self = this;

      return self.table['$[]='](name.$to_sym(), value);
    };

    def.$method_missing = function(name, args) {
      var $a, self = this;

      args = $slice.call(arguments, 1);
      if ((($a = name['$end_with?']("=")) !== nil && (!$a._isBoolean || $a == true))) {
        return self.table['$[]='](name['$[]']($range(0, -2, false)).$to_sym(), args['$[]'](0))
        } else {
        return self.table['$[]'](name.$to_sym())
      };
    };

    def.$each_pair = TMP_2 = function() {
      var $a, $b, TMP_3, self = this, $iter = TMP_2._p, $yield = $iter || nil;

      TMP_2._p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("each_pair")
      };
      return ($a = ($b = self.table).$each_pair, $a._p = (TMP_3 = function(pair){var self = TMP_3._s || this, $a;
if (pair == null) pair = nil;
      return $a = $opal.$yield1($yield, pair), $a === $breaker ? $a : $a}, TMP_3._s = self, TMP_3), $a).call($b);
    };

    def['$=='] = function(other) {
      var $a, $b, self = this;

      if ((($a = other['$is_a?']((($b = $scope.OpenStruct) == null ? $opal.cm('OpenStruct') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      return self.table['$=='](other.$instance_variable_get("@table"));
    };

    def['$==='] = function(other) {
      var $a, $b, self = this;

      if ((($a = other['$is_a?']((($b = $scope.OpenStruct) == null ? $opal.cm('OpenStruct') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      return self.table['$==='](other.$instance_variable_get("@table"));
    };

    def['$eql?'] = function(other) {
      var $a, $b, self = this;

      if ((($a = other['$is_a?']((($b = $scope.OpenStruct) == null ? $opal.cm('OpenStruct') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      return self.table['$eql?'](other.$instance_variable_get("@table"));
    };

    def.$to_h = function() {
      var self = this;

      return self.table.$dup();
    };

    def.$to_n = function() {
      var self = this;

      return self.table.$to_n();
    };

    def.$hash = function() {
      var self = this;

      return self.table.$hash();
    };

    return (def.$inspect = function() {
      var $a, $b, TMP_4, self = this;

      return "#<" + (self.$class()) + ": " + (($a = ($b = self.$each_pair()).$map, $a._p = (TMP_4 = function(name, value){var self = TMP_4._s || this;
if (name == null) name = nil;if (value == null) value = nil;
      return "" + (name) + "=" + (self['$[]'](name).$inspect())}, TMP_4._s = self, TMP_4), $a).call($b).$join(" ")) + ">";
    }, nil) && 'inspect';
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/ostruct.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $range = $opal.range;

  $opal.add_stubs(['$supports?', '$end_with?', '$[]', '$to_n', '$merge!', '$Native', '$new', '$has_key?']);
  ;
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Custom(){};
          var self = $Custom = $klass($base, $super, 'Custom', $Custom);

          var def = self._proto, $scope = self._scope, $a, $b, TMP_1, TMP_2;

          def.detail = nil;
          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Custom");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            return (def.$method_missing = function(name, value) {
              var $a, self = this;

              if ((($a = name['$end_with?']("=")) !== nil && (!$a._isBoolean || $a == true))) {
                return self["native"][name['$[]']($range(0, -2, false))] = value;
                } else {
                return nil
              };
            }, nil) && 'method_missing'
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
            $opal.defs(self, '$construct', function(name, desc) {
              var self = this;

              return new CustomEvent(name, {
        bubbles:    desc.bubbles,
        cancelable: desc.cancelable,
        detail:     desc });
            })
          } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
            $opal.defs(self, '$construct', function(name, desc) {
              var self = this;

              
        var event = document.createEvent("CustomEvent");
            event.initCustomEvent(name, desc.bubbles, desc.cancelable, desc);

        return event;
      
            })
          } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.createObject")) !== nil && (!$a._isBoolean || $a == true))) {
            $opal.defs(self, '$construct', function(name, desc) {
              var self = this;

              return self.$Native(document.createEventObject())['$merge!']({
        type:       name,
        bubbles:    desc.bubbles,
        cancelable: desc.cancelable,
        detail:     desc }).$to_n();
            })
            } else {
            $opal.defs(self, '$construct', function(name, desc) {
              var self = this;

              return self.$Native(desc)['$merge!']({
        type:       name,
        bubbles:    desc.bubbles,
        cancelable: desc.cancelable,
        detail:     desc }).$to_n();
            })
          };

          def.$initialize = TMP_1 = function(event, callback) {
            var $a, self = this, $iter = TMP_1._p, $yield = $iter || nil;

            if (callback == null) {
              callback = nil
            }
            TMP_1._p = null;
            $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [event, callback]);
            return self.detail = (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a).$new(event.detail);
          };

          return (def.$method_missing = TMP_2 = function(id) {var $zuper = $slice.call(arguments, 0);
            var $a, self = this, $iter = TMP_2._p, $yield = $iter || nil;

            TMP_2._p = null;
            if ((($a = self.detail['$has_key?'](id)) !== nil && (!$a._isBoolean || $a == true))) {
              return self.detail['$[]'](id)};
            return $opal.find_super_dispatcher(self, 'method_missing', TMP_2, $iter).apply(self, $zuper);
          }, nil) && 'method_missing';
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/custom.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$[]', '$name_for', '$include', '$attr_reader', '$==', '$for', '$to_n', '$enum_for']);
  return (function($base, $super) {
    function $Buffer(){};
    var self = $Buffer = $klass($base, $super, 'Buffer', $Buffer);

    var def = self._proto, $scope = self._scope, $a;

    return (function($base, $super) {
      function $Array(){};
      var self = $Array = $klass($base, $super, 'Array', $Array);

      var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2;

      def["native"] = nil;
      $opal.defs(self, '$for', function(bits, type) {
        var $a, self = this;
        if ($gvars.$ == null) $gvars.$ = nil;

        return $gvars.$['$[]']("" + ((($a = $scope.Buffer) == null ? $opal.cm('Buffer') : $a).$name_for(bits, type)) + "Array");
      });

      self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

      self.$attr_reader("buffer", "type");

      def.$initialize = TMP_1 = function(buffer, bits, type) {
        var $a, self = this, $iter = TMP_1._p, $yield = $iter || nil;

        if (bits == null) {
          bits = nil
        }
        if (type == null) {
          type = nil
        }
        TMP_1._p = null;
        if ((($a = $scope.Native) == null ? $opal.cm('Native') : $a)['$=='](buffer)) {
          $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [buffer])
          } else {
          
        var klass = (($a = $scope.Array) == null ? $opal.cm('Array') : $a).$for(bits, type);

        $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new klass(buffer.$to_n())])
      ;
        };
        self.buffer = buffer;
        return self.type = type;
      };

      def.$bits = function() {
        var self = this;

        return self["native"].BYTES_PER_ELEMENT * 8;
      };

      def['$[]'] = function(index, offset) {
        var self = this;

        if (offset == null) {
          offset = nil
        }
        if (offset !== false && offset !== nil) {
          return self["native"].subarray(index, offset);
          } else {
          return self["native"][index];
        };
      };

      def['$[]='] = function(index, value) {
        var self = this;

        return self["native"][index] = value;
      };

      def.$bytesize = function() {
        var self = this;

        return self["native"].byteLength;
      };

      def.$each = TMP_2 = function() {
        var $a, self = this, $iter = TMP_2._p, $yield = $iter || nil;

        TMP_2._p = null;
        if (($yield !== nil)) {
          } else {
          return self.$enum_for("each")
        };
        
      for (var i = 0, length = self["native"].length; i < length; i++) {
        ((($a = $opal.$yield1($yield, self["native"][i])) === $breaker) ? $breaker.$v : $a)
      }
    ;
        return self;
      };

      def.$length = function() {
        var self = this;

        return self["native"].length;
      };

      def['$merge!'] = function(other, offset) {
        var self = this;

        return self["native"].set(other.$to_n(), offset);
      };

      return $opal.defn(self, '$size', def.$length);
    })(self, (($a = $scope.Native) == null ? $opal.cm('Native') : $a))
  })(self, (($a = $scope.Native) == null ? $opal.cm('Native') : $a))
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/buffer/array.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$include', '$!', '$nil?', '$[]', '$attr_reader', '$native?', '$to_n', '$name_for']);
  return (function($base, $super) {
    function $Buffer(){};
    var self = $Buffer = $klass($base, $super, 'Buffer', $Buffer);

    var def = self._proto, $scope = self._scope;

    return (function($base, $super) {
      function $View(){};
      var self = $View = $klass($base, $super, 'View', $View);

      var def = self._proto, $scope = self._scope, $a, TMP_1;

      def["native"] = nil;
      self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

      $opal.defs(self, '$supported?', function() {
        var self = this;
        if ($gvars.$ == null) $gvars.$ = nil;

        return $gvars.$['$[]']("DataView")['$nil?']()['$!']();
      });

      self.$attr_reader("buffer", "offset");

      def.$initialize = TMP_1 = function(buffer, offset, length) {
        var $a, $b, self = this, $iter = TMP_1._p, $yield = $iter || nil;

        if (offset == null) {
          offset = nil
        }
        if (length == null) {
          length = nil
        }
        TMP_1._p = null;
        if ((($a = self['$native?'](buffer)) !== nil && (!$a._isBoolean || $a == true))) {
          $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [buffer])
        } else if ((($a = (($b = offset !== false && offset !== nil) ? length : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new DataView(buffer.$to_n(), offset.$to_n(), length.$to_n())])
        } else if (offset !== false && offset !== nil) {
          $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new DataView(buffer.$to_n(), offset.$to_n())])
          } else {
          $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new DataView(buffer.$to_n())])
        };
        self.buffer = buffer;
        return self.offset = offset;
      };

      def.$length = function() {
        var self = this;

        return self["native"].byteLength;
      };

      $opal.defn(self, '$size', def.$length);

      def.$get = function(offset, bits, type, little) {
        var $a, self = this;

        if (bits == null) {
          bits = 8
        }
        if (type == null) {
          type = "unsigned"
        }
        if (little == null) {
          little = false
        }
        return self["native"]["get" + (($a = $scope.Buffer) == null ? $opal.cm('Buffer') : $a).$name_for(bits, type)](offset, little);
      };

      $opal.defn(self, '$[]', def.$get);

      def.$set = function(offset, value, bits, type, little) {
        var $a, self = this;

        if (bits == null) {
          bits = 8
        }
        if (type == null) {
          type = "unsigned"
        }
        if (little == null) {
          little = false
        }
        return self["native"]["set" + (($a = $scope.Buffer) == null ? $opal.cm('Buffer') : $a).$name_for(bits, type)](offset, value, little);
      };

      $opal.defn(self, '$[]=', def.$set);

      def.$get_int8 = function(offset, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].getInt8(offset, little);
      };

      def.$set_int8 = function(offset, value, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].setInt8(offset, value, little);
      };

      def.$get_uint8 = function(offset, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].getUint8(offset, little);
      };

      def.$set_uint8 = function(offset, value, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].setUint8(offset, value, little);
      };

      def.$get_int16 = function(offset, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].getInt16(offset, little);
      };

      def.$set_int16 = function(offset, value, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].setInt16(offset, value, little);
      };

      def.$get_uint16 = function(offset, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].getUint16(offset, little);
      };

      def.$set_uint16 = function(offset, value, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].setUint16(offset, value, little);
      };

      def.$get_int32 = function(offset, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].getInt32(offset, little);
      };

      def.$set_int32 = function(offset, value, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].setInt32(offset, value, little);
      };

      def.$get_uint32 = function(offset, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].getUint32(offset, little);
      };

      def.$set_uint32 = function(offset, value, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].setUint32(offset, value, little);
      };

      def.$get_float32 = function(offset, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].getFloat32(offset, little);
      };

      def.$set_float32 = function(offset, value, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].setFloat32(offset, value, little);
      };

      def.$get_float64 = function(offset, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].getFloat64(offset, little);
      };

      return (def.$set_float64 = function(offset, value, little) {
        var self = this;

        if (little == null) {
          little = false
        }
        return self["native"].setFloat64(offset, value, little);
      }, nil) && 'set_float64';
    })(self, null)
  })(self, null)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/buffer/view.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$include', '$!', '$nil?', '$[]', '$===', '$native?', '$new']);
  ;
  ;
  return (function($base, $super) {
    function $Buffer(){};
    var self = $Buffer = $klass($base, $super, 'Buffer', $Buffer);

    var def = self._proto, $scope = self._scope, $a, TMP_1;

    def["native"] = nil;
    self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

    $opal.defs(self, '$supported?', function() {
      var self = this;
      if ($gvars.$ == null) $gvars.$ = nil;

      return $gvars.$['$[]']("ArrayBuffer")['$nil?']()['$!']();
    });

    $opal.defs(self, '$name_for', function(bits, type) {
      var self = this, $case = nil;

      return "" + ((function() {$case = type;if ("unsigned"['$===']($case)) {return "Uint"}else if ("signed"['$===']($case)) {return "Int"}else if ("float"['$===']($case)) {return "Float"}else { return nil }})()) + (bits);
    });

    def.$initialize = TMP_1 = function(size, bits) {
      var $a, self = this, $iter = TMP_1._p, $yield = $iter || nil;

      if (bits == null) {
        bits = 8
      }
      TMP_1._p = null;
      if ((($a = self['$native?'](size)) !== nil && (!$a._isBoolean || $a == true))) {
        return $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [size])
        } else {
        return $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new ArrayBuffer(size * (bits / 8))])
      };
    };

    def.$length = function() {
      var self = this;

      return self["native"].byteLength;
    };

    $opal.defn(self, '$size', def.$length);

    def.$to_a = function(bits, type) {
      var $a, self = this;

      if (bits == null) {
        bits = 8
      }
      if (type == null) {
        type = "unsigned"
      }
      return (($a = $scope.Array) == null ? $opal.cm('Array') : $a).$new(self, bits, type);
    };

    return (def.$view = function(offset, length) {
      var $a, self = this;

      if (offset == null) {
        offset = nil
      }
      if (length == null) {
        length = nil
      }
      return (($a = $scope.View) == null ? $opal.cm('View') : $a).$new(self, offset, length);
    }, nil) && 'view';
  })(self, null);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/buffer.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$convert', '$supported?', '$new', '$alias_native']);
  ;
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Message(){};
          var self = $Message = $klass($base, $super, 'Message', $Message);

          var def = self._proto, $scope = self._scope, $a, $b;

          def["native"] = nil;
          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Message");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$data='] = function(value) {
              var self = this;

              return self["native"].data = value;
            };

            def['$origin='] = function(value) {
              var self = this;

              return self["native"].origin = value;
            };

            return (def['$source='] = function(value) {
              var $a, self = this;

              return self["native"].source = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(value);
            }, nil) && 'source=';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new MessageEvent(name, desc);
              })
            } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                
        var event = document.createEvent("MessageEvent");
            event.initMessageEvent(name, desc.bubbles, desc.cancelable,
              desc.data, desc.origin, "", desc.source || window);

        return event;
      
              })}};

          def.$data = function() {
            var $a, self = this;

            
      if (window.ArrayBuffer && self["native"].data instanceof ArrayBuffer) {
        return (($a = $scope.Buffer) == null ? $opal.cm('Buffer') : $a).$new(self["native"].data);
      }
      else if (window.Blob && self["native"].data instanceof Blob) {
        return (($a = $scope.Blob) == null ? $opal.cm('Blob') : $a).$new(self["native"].data);
      }
      else {
        return self["native"].data;
      }
    ;
          };

          self.$alias_native("origin");

          return (def.$source = function() {
            var $a, self = this;

            
      var source = self["native"].source;

      if (window.Window && source instanceof window.Window) {
        return (($a = $scope.Window) == null ? $opal.cm('Window') : $a).$new(source);
      }
      else {
        return nil;
      }
    ;
          }, nil) && 'source';
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/message.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$supports?', '$supported?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Close(){};
          var self = $Close = $klass($base, $super, 'Close', $Close);

          var def = self._proto, $scope = self._scope, $a, $b;

          $opal.defs(self, '$supported?', function() {
            var $a, self = this;

            return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("Event.Close");
          });

          (function($base, $super) {
            function $Definition(){};
            var self = $Definition = $klass($base, $super, 'Definition', $Definition);

            var def = self._proto, $scope = self._scope;

            def["native"] = nil;
            def['$code='] = function(value) {
              var self = this;

              return self["native"].code = value;
            };

            def['$reason='] = function(value) {
              var self = this;

              return self["native"].reason = value;
            };

            def['$clean!'] = function(value) {
              var self = this;

              return self["native"].wasClean = true;
            };

            return (def['$not_clean!'] = function(value) {
              var self = this;

              return self["native"].wasClean = false;
            }, nil) && 'not_clean!';
          })(self, (($a = $scope.Definition) == null ? $opal.cm('Definition') : $a));

          if ((($a = self['$supported?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                return new CloseEvent(name, desc);
              })
            } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.defs(self, '$construct', function(name, desc) {
                var self = this;

                
        var event = document.createEvent("CloseEvent");
            event.initCloseEvent(name, desc.bubbles, desc.cancelable,
              desc.wasClean, desc.code, desc.reason);

        return event;
      
              })}};

          self.$alias_native("code");

          self.$alias_native("reason");

          return self.$alias_native("clean?", "wasClean");
        })(self, (($a = $scope.Event) == null ? $opal.cm('Event') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event/close.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$gsub', '$[]', '$aliases', '$name_for', '$===', '$class_for', '$new', '$construct', '$to_proc', '$const_get', '$arguments=', '$supports?', '$merge!', '$Native', '$to_n', '$==', '$name', '$attr_reader', '$attr_writer', '$convert', '$alias_native', '$off', '$prevent', '$stop']);
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Event(){};
        var self = $Event = $klass($base, $super, 'Event', $Event);

        var def = self._proto, $scope = self._scope, TMP_1, $a, $b, TMP_2, TMP_3;

        def["native"] = def.on = def.callback = nil;
        $opal.defs(self, '$aliases', function() {
          var $a, self = this;
          if (self.aliases == null) self.aliases = nil;

          return ((($a = self.aliases) !== false && $a !== nil) ? $a : self.aliases = $hash2(["dom:load", "hover"], {"dom:load": "DOMContentLoaded", "hover": "mouse:over"}));
        });

        $opal.defs(self, '$name_for', function(name) {
          var $a, self = this;

          return (((($a = self.$aliases()['$[]'](name)) !== false && $a !== nil) ? $a : name)).$gsub(":", "");
        });

        $opal.defs(self, '$class_for', function(name) {
          var $a, self = this, type = nil, $case = nil;

          return type = (function() {$case = self.$name_for(name);if ("animationend"['$===']($case) || "animationiteration"['$===']($case) || "animationstart"['$===']($case)) {return (($a = $scope.Animation) == null ? $opal.cm('Animation') : $a)}else if ("audioprocess"['$===']($case)) {return (($a = $scope.AudioProcessing) == null ? $opal.cm('AudioProcessing') : $a)}else if ("beforeunload"['$===']($case)) {return (($a = $scope.BeforeUnload) == null ? $opal.cm('BeforeUnload') : $a)}else if ("compositionend"['$===']($case) || "compositionstart"['$===']($case) || "compositionupdate"['$===']($case)) {return (($a = $scope.Composition) == null ? $opal.cm('Composition') : $a)}else if ("copy"['$===']($case) || "cut"['$===']($case)) {return (($a = $scope.Clipboard) == null ? $opal.cm('Clipboard') : $a)}else if ("devicelight"['$===']($case)) {return (($a = $scope.DeviceLight) == null ? $opal.cm('DeviceLight') : $a)}else if ("devicemotion"['$===']($case)) {return (($a = $scope.DeviceMotion) == null ? $opal.cm('DeviceMotion') : $a)}else if ("deviceorientation"['$===']($case)) {return (($a = $scope.DeviceOrientation) == null ? $opal.cm('DeviceOrientation') : $a)}else if ("deviceproximity"['$===']($case)) {return (($a = $scope.DeviceProximity) == null ? $opal.cm('DeviceProximity') : $a)}else if ("drag"['$===']($case) || "dragend"['$===']($case) || "dragleave"['$===']($case) || "dragover"['$===']($case) || "dragstart"['$===']($case) || "drop"['$===']($case)) {return (($a = $scope.Drag) == null ? $opal.cm('Drag') : $a)}else if ("gamepadconnected"['$===']($case) || "gamepaddisconnected"['$===']($case)) {return (($a = $scope.Gamepad) == null ? $opal.cm('Gamepad') : $a)}else if ("hashchange"['$===']($case)) {return (($a = $scope.HashChange) == null ? $opal.cm('HashChange') : $a)}else if ("load"['$===']($case) || "loadend"['$===']($case) || "loadstart"['$===']($case)) {return (($a = $scope.Progress) == null ? $opal.cm('Progress') : $a)}else if ("pagehide"['$===']($case) || "pageshow"['$===']($case)) {return (($a = $scope.PageTransition) == null ? $opal.cm('PageTransition') : $a)}else if ("popstate"['$===']($case)) {return (($a = $scope.PopState) == null ? $opal.cm('PopState') : $a)}else if ("storage"['$===']($case)) {return (($a = $scope.Storage) == null ? $opal.cm('Storage') : $a)}else if ("touchcancel"['$===']($case) || "touchend"['$===']($case) || "touchleave"['$===']($case) || "touchmove"['$===']($case) || "touchstart"['$===']($case)) {return (($a = $scope.Touch) == null ? $opal.cm('Touch') : $a)}else if ("compassneedscalibration"['$===']($case) || "userproximity"['$===']($case)) {return (($a = $scope.Sensor) == null ? $opal.cm('Sensor') : $a)}else if ("message"['$===']($case)) {return (($a = $scope.Message) == null ? $opal.cm('Message') : $a)}else if ("close"['$===']($case)) {return (($a = $scope.Close) == null ? $opal.cm('Close') : $a)}else if ("click"['$===']($case) || "contextmenu"['$===']($case) || "dblclick"['$===']($case) || "mousedown"['$===']($case) || "mouseenter"['$===']($case) || "mouseleave"['$===']($case) || "mousemove"['$===']($case) || "mouseout"['$===']($case) || "mouseover"['$===']($case) || "mouseup"['$===']($case) || "show"['$===']($case)) {return (($a = $scope.Mouse) == null ? $opal.cm('Mouse') : $a)}else if ("keydown"['$===']($case) || "keypress"['$===']($case) || "keyup"['$===']($case)) {return (($a = $scope.Keyboard) == null ? $opal.cm('Keyboard') : $a)}else if ("blur"['$===']($case) || "focus"['$===']($case) || "focusin"['$===']($case) || "focusout"['$===']($case)) {return (($a = $scope.Focus) == null ? $opal.cm('Focus') : $a)}else if ("wheel"['$===']($case)) {return (($a = $scope.Wheel) == null ? $opal.cm('Wheel') : $a)}else if ("abort"['$===']($case) || "afterprint"['$===']($case) || "beforeprint"['$===']($case) || "cached"['$===']($case) || "canplay"['$===']($case) || "canplaythrough"['$===']($case) || "change"['$===']($case) || "chargingchange"['$===']($case) || "chargingtimechange"['$===']($case) || "checking"['$===']($case) || "close"['$===']($case) || "dischargingtimechange"['$===']($case) || "DOMContentLoaded"['$===']($case) || "downloading"['$===']($case) || "durationchange"['$===']($case) || "emptied"['$===']($case) || "ended"['$===']($case) || "error"['$===']($case) || "fullscreenchange"['$===']($case) || "fullscreenerror"['$===']($case) || "input"['$===']($case) || "invalid"['$===']($case) || "levelchange"['$===']($case) || "loadeddata"['$===']($case) || "loadedmetadata"['$===']($case) || "noupdate"['$===']($case) || "obsolete"['$===']($case) || "offline"['$===']($case) || "online"['$===']($case) || "open"['$===']($case) || "orientationchange"['$===']($case) || "pause"['$===']($case) || "pointerlockchange"['$===']($case) || "pointerlockerror"['$===']($case) || "play"['$===']($case) || "playing"['$===']($case) || "ratechange"['$===']($case) || "readystatechange"['$===']($case) || "reset"['$===']($case) || "seeked"['$===']($case) || "seeking"['$===']($case) || "stalled"['$===']($case) || "submit"['$===']($case) || "success"['$===']($case) || "suspend"['$===']($case) || "timeupdate"['$===']($case) || "updateready"['$===']($case) || "visibilitychange"['$===']($case) || "volumechange"['$===']($case) || "waiting"['$===']($case)) {return (($a = $scope.Event) == null ? $opal.cm('Event') : $a)}else {return (($a = $scope.Custom) == null ? $opal.cm('Custom') : $a)}})();
        });

        $opal.defs(self, '$supported?', function() {
          var self = this;

          return true;
        });

        $opal.defs(self, '$create', TMP_1 = function(name, args) {
          var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil, klass = nil, event = nil;

          args = $slice.call(arguments, 1);
          TMP_1._p = null;
          name = self.$name_for(name);
          klass = self.$class_for(name);
          event = klass.$new(klass.$construct(name, ($a = ($b = klass.$const_get("Definition")).$new, $a._p = block.$to_proc(), $a).call($b)));
          event['$arguments='](args);
          return event;
        });

        if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.constructor")) !== nil && (!$a._isBoolean || $a == true))) {
          $opal.defs(self, '$construct', function(name, desc) {
            var self = this;

            return new Event(name, desc);
          })
        } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.create")) !== nil && (!$a._isBoolean || $a == true))) {
          $opal.defs(self, '$construct', function(name, desc) {try {

            var self = this;

            
        var event = document.createEvent("HTMLEvents");
            event.initEvent(name, desc.bubbles, desc.cancelable);

        $opal.$return(self.$Native(event)['$merge!'](desc));
      
            } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
          })
        } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Event.createObject")) !== nil && (!$a._isBoolean || $a == true))) {
          $opal.defs(self, '$construct', function(name, desc) {
            var self = this;

            return self.$Native(document.createEventObject())['$merge!'](desc)['$merge!']({ type: name }).$to_n();
          })
          } else {
          $opal.defs(self, '$construct', function(name, desc) {
            var self = this;

            return self.$Native(desc)['$merge!']({ type: name }).$to_n();
          })
        };

        $opal.defs(self, '$new', TMP_2 = function(value, callback) {var $zuper = $slice.call(arguments, 0);
          var $a, self = this, $iter = TMP_2._p, $yield = $iter || nil, klass = nil;

          if (callback == null) {
            callback = nil
          }
          TMP_2._p = null;
          if (self['$==']((($a = $scope.Event) == null ? $opal.cm('Event') : $a))) {
            } else {
            return $opal.find_super_dispatcher(self, 'new', TMP_2, $iter, $Event).apply(self, $zuper)
          };
          klass = self.$class_for((function() {if (callback !== false && callback !== nil) {
            return callback.$name()
            } else {
            return value.type;
          }; return nil; })());
          if (klass['$==']((($a = $scope.Event) == null ? $opal.cm('Event') : $a))) {
            return $opal.find_super_dispatcher(self, 'new', TMP_2, $iter, $Event).apply(self, $zuper)
            } else {
            return klass.$new(value, callback)
          };
        });

        self.$attr_reader("callback");

        self.$attr_writer("on");

        def.$initialize = TMP_3 = function(event, callback) {
          var self = this, $iter = TMP_3._p, $yield = $iter || nil;

          if (callback == null) {
            callback = nil
          }
          TMP_3._p = null;
          $opal.find_super_dispatcher(self, 'initialize', TMP_3, null).apply(self, [event]);
          return self.callback = callback;
        };

        def.$name = function() {
          var self = this;

          return self["native"].type;
        };

        def.$on = function() {
          var $a, $b, self = this;

          return ((($a = self.on) !== false && $a !== nil) ? $a : (($b = $scope.Target) == null ? $opal.cm('Target') : $b).$convert(self["native"].currentTarget));
        };

        def.$target = function() {
          var $a, self = this;

          return (($a = $scope.Target) == null ? $opal.cm('Target') : $a).$convert(self["native"].srcElement || self["native"].target);
        };

        def.$arguments = function() {
          var self = this;

          return self["native"].arguments || [];
        };

        def['$arguments='] = function(args) {
          var self = this;

          return self["native"].arguments = args;
        };

        self.$alias_native("bubbles?", "bubbles");

        self.$alias_native("cancelable?", "cancelable");

        self.$alias_native("data");

        self.$alias_native("phase", "eventPhase");

        self.$alias_native("at", "timeStamp");

        def.$off = function() {
          var $a, self = this;

          if ((($a = self.callback) !== nil && (!$a._isBoolean || $a == true))) {
            return self.callback.$off()
            } else {
            return nil
          };
        };

        def['$stopped?'] = function() {
          var self = this;

          return !!self["native"].stopped;
        };

        def.$stop = function() {
          var $a, self = this;

          if ((($a = (typeof(self["native"].stopPropagation) !== "undefined")) !== nil && (!$a._isBoolean || $a == true))) {
            self["native"].stopPropagation();};
          return self["native"].stopped = true;
        };

        def.$prevent = function() {
          var $a, self = this;

          if ((($a = (typeof(self["native"].preventDefault) !== "undefined")) !== nil && (!$a._isBoolean || $a == true))) {
            self["native"].preventDefault();};
          return self["native"].prevented = true;
        };

        def['$prevented?'] = function() {
          var self = this;

          return !!self["native"].prevented;
        };

        return (def['$stop!'] = function() {
          var self = this;

          self.$prevent();
          return self.$stop();
        }, nil) && 'stop!';
      })(self, null)
      
    })(self)
    
  })(self);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/event.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $range = $opal.range;

  $opal.add_stubs(['$attr_reader', '$each', '$===', '$concat', '$to_a', '$push', '$DOM', '$convert', '$respond_to?', '$__send__', '$to_proc', '$new', '$document', '$dup', '$to_ary', '$select', '$matches?', '$after', '$last', '$raise', '$before', '$first', '$children', '$uniq', '$flatten', '$map', '$search', '$[]', '$inspect']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $NodeSet(){};
        var self = $NodeSet = $klass($base, $super, 'NodeSet', $NodeSet);

        var def = self._proto, $scope = self._scope, TMP_2;

        def.literal = def.document = nil;
        self.$attr_reader("document");

        def.$initialize = function(document, list) {
          var $a, $b, TMP_1, self = this;

          if (list == null) {
            list = []
          }
          self.document = document;
          self.literal = [];
          return ($a = ($b = list).$each, $a._p = (TMP_1 = function(el){var self = TMP_1._s || this, $a, $b;
            if (self.literal == null) self.literal = nil;
if (el == null) el = nil;
          if ((($a = (($b = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $b)['$==='](el)) !== nil && (!$a._isBoolean || $a == true))) {
              return self.literal.$concat(el.$to_a())
              } else {
              return self.literal.$push(self.$DOM((($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(el)))
            }}, TMP_1._s = self, TMP_1), $a).call($b);
        };

        def['$respond_to_missing?'] = function(name) {
          var self = this;

          return self.literal['$respond_to?'](name);
        };

        def.$method_missing = TMP_2 = function(name, args) {
          var $a, $b, TMP_3, $c, $d, self = this, $iter = TMP_2._p, block = $iter || nil, result = nil;

          args = $slice.call(arguments, 1);
          TMP_2._p = null;
          if ((($a = self.literal['$respond_to?'](name)) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            ($a = ($b = self).$each, $a._p = (TMP_3 = function(el){var self = TMP_3._s || this, $a, $b;
if (el == null) el = nil;
            return ($a = ($b = el).$__send__, $a._p = block.$to_proc(), $a).apply($b, [name].concat(args))}, TMP_3._s = self, TMP_3), $a).call($b);
            return self;
          };
          result = ($a = ($c = self.literal).$__send__, $a._p = block.$to_proc(), $a).apply($c, [name].concat(args));
          if ((($a = result === self.literal) !== nil && (!$a._isBoolean || $a == true))) {
            return self
          } else if ((($a = (($d = $scope.Array) == null ? $opal.cm('Array') : $d)['$==='](result)) !== nil && (!$a._isBoolean || $a == true))) {
            return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new(self.document, result)
            } else {
            return result
          };
        };

        def.$dup = function() {
          var $a, self = this;

          return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new(self.$document(), self.$to_ary().$dup());
        };

        def.$filter = function(expression) {
          var $a, $b, TMP_4, self = this;

          return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new(self.$document(), ($a = ($b = self.literal).$select, $a._p = (TMP_4 = function(node){var self = TMP_4._s || this;
if (node == null) node = nil;
          return node['$matches?'](expression)}, TMP_4._s = self, TMP_4), $a).call($b));
        };

        def.$after = function(node) {
          var self = this;

          return self.$last().$after(node);
        };

        def.$at = function(path) {
          var $a, self = this;

          return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
        };

        def.$at_css = function(rules) {
          var $a, self = this;

          rules = $slice.call(arguments, 0);
          return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
        };

        def.$at_xpath = function(paths) {
          var $a, self = this;

          paths = $slice.call(arguments, 0);
          return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
        };

        def.$before = function() {
          var self = this;

          return self.$first().$before();
        };

        def.$children = function() {
          var $a, $b, TMP_5, self = this, result = nil;

          result = (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new(self.$document());
          ($a = ($b = self).$each, $a._p = (TMP_5 = function(n){var self = TMP_5._s || this;
if (n == null) n = nil;
          return result.$concat(n.$children())}, TMP_5._s = self, TMP_5), $a).call($b);
          return result;
        };

        def.$css = function(paths) {
          var $a, self = this;

          paths = $slice.call(arguments, 0);
          return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
        };

        def.$search = function(what) {
          var $a, $b, TMP_6, self = this;

          what = $slice.call(arguments, 0);
          return ($a = ($b = self).$map, $a._p = (TMP_6 = function(n){var self = TMP_6._s || this, $a;
if (n == null) n = nil;
          return ($a = n).$search.apply($a, [].concat(what))}, TMP_6._s = self, TMP_6), $a).call($b).$flatten().$uniq();
        };

        return (def.$inspect = function() {
          var self = this;

          return "#<DOM::NodeSet: " + (self.literal.$inspect()['$[]']($range(1, -2, false)));
        }, nil) && 'inspect';
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/node_set.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$include', '$==', '$[]', '$new', '$raise', '$try_convert', '$downcase', '$name', '$native?', '$respond_to?', '$each', '$add_child', '$===', '$convert', '$parent', '$document', '$last', '$<<', '$pop', '$select!', '$matches?', '$remove_child', '$to_proc', '$children', '$supports?', '$node_type', '$first', '$DOM', '$select', '$element_children', '$to_s', '$next', '$!', '$element?', '$previous']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Node(){};
        var self = $Node = $klass($base, $super, 'Node', $Node);

        var def = self._proto, $scope = self._scope, $a, TMP_1, $b, TMP_4;

        def["native"] = nil;
        self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

        $opal.cdecl($scope, 'ELEMENT_NODE', 1);

        $opal.cdecl($scope, 'ATTRIBUTE_NODE', 2);

        $opal.cdecl($scope, 'TEXT_NODE', 3);

        $opal.cdecl($scope, 'CDATA_SECTION_NODE', 4);

        $opal.cdecl($scope, 'ENTITY_REFERENCE_NOCE', 5);

        $opal.cdecl($scope, 'ENTITY_NODE', 6);

        $opal.cdecl($scope, 'PROCESSING_INSTRUCTION_NODE', 7);

        $opal.cdecl($scope, 'COMMENT_NODE', 8);

        $opal.cdecl($scope, 'DOCUMENT_NODE', 9);

        $opal.cdecl($scope, 'DOCUMENT_TYPE_NODE', 10);

        $opal.cdecl($scope, 'DOCUMENT_FRAGMENT_NODE', 11);

        $opal.cdecl($scope, 'NOTATION_NODE', 12);

        $opal.defs(self, '$new', TMP_1 = function(value) {var $zuper = $slice.call(arguments, 0);
          var $a, $b, self = this, $iter = TMP_1._p, $yield = $iter || nil, klass = nil;
          if (self.classes == null) self.classes = nil;

          TMP_1._p = null;
          if (self['$==']((($a = $scope.Node) == null ? $opal.cm('Node') : $a))) {
            ((($a = self.classes) !== false && $a !== nil) ? $a : self.classes = [nil, (($b = $scope.Element) == null ? $opal.cm('Element') : $b), (($b = $scope.Attribute) == null ? $opal.cm('Attribute') : $b), (($b = $scope.Text) == null ? $opal.cm('Text') : $b), (($b = $scope.CDATA) == null ? $opal.cm('CDATA') : $b), nil, nil, nil, (($b = $scope.Comment) == null ? $opal.cm('Comment') : $b), (($b = $scope.Document) == null ? $opal.cm('Document') : $b), nil, (($b = $scope.DocumentFragment) == null ? $opal.cm('DocumentFragment') : $b)]);
            if ((($a = klass = self.classes['$[]'](value.nodeType)) !== nil && (!$a._isBoolean || $a == true))) {
              return klass.$new(value)
              } else {
              return self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "cannot instantiate a non derived Node object")
            };
            } else {
            return $opal.find_super_dispatcher(self, 'new', TMP_1, $iter, $Node).apply(self, $zuper)
          };
        });

        def['$=='] = function(other) {
          var $a, self = this;

          return self["native"] === (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$try_convert(other);
        };

        def['$=~'] = function(name) {
          var self = this;

          return self.$name().$downcase()['$=='](name.$downcase());
        };

        def['$<<'] = function(node) {
          var $a, $b, TMP_2, $c, self = this;

          if ((($a = self['$native?'](node)) !== nil && (!$a._isBoolean || $a == true))) {
            self["native"].appendChild(node);
          } else if ((($a = node['$respond_to?']("each")) !== nil && (!$a._isBoolean || $a == true))) {
            ($a = ($b = node).$each, $a._p = (TMP_2 = function(n){var self = TMP_2._s || this;
if (n == null) n = nil;
            return self.$add_child(n)}, TMP_2._s = self, TMP_2), $a).call($b)
          } else if ((($a = (($c = $scope.String) == null ? $opal.cm('String') : $c)['$==='](node)) !== nil && (!$a._isBoolean || $a == true))) {
            self["native"].appendChild(self["native"].ownerDocument.createTextNode(node));
            } else {
            self["native"].appendChild((($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(node));
          };
          return self;
        };

        $opal.defn(self, '$add_child', def['$<<']);

        def.$add_next_sibling = function(node) {
          var $a, $b, self = this;

          if ((($a = self['$native?'](node)) !== nil && (!$a._isBoolean || $a == true))) {
            return self["native"].parentNode.insertBefore(node, self["native"].nextSibling);
          } else if ((($a = (($b = $scope.String) == null ? $opal.cm('String') : $b)['$==='](node)) !== nil && (!$a._isBoolean || $a == true))) {
            return self["native"].parentNode.insertBefore(
        self["native"].ownerDocument.createTextNode(node), self["native"].nextSibling);
            } else {
            return self["native"].parentNode.insertBefore((($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(node),
        self["native"].nextSibling);
          };
        };

        def.$add_previous_sibling = function(node) {
          var $a, $b, self = this;

          if ((($a = self['$native?'](node)) !== nil && (!$a._isBoolean || $a == true))) {
            return self["native"].parentNode.insertBefore(node, self["native"]);
          } else if ((($a = (($b = $scope.String) == null ? $opal.cm('String') : $b)['$==='](node)) !== nil && (!$a._isBoolean || $a == true))) {
            return self["native"].parentNode.insertBefore(
        self["native"].ownerDocument.createTextNode(node), self["native"]);
            } else {
            return self["native"].parentNode.insertBefore((($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(node), self["native"]);
          };
        };

        $opal.defn(self, '$after', def.$add_next_sibling);

        def.$append_to = function(node) {
          var self = this;

          return node.$add_child(self);
        };

        def.$ancestors = function(expression) {
          var $a, $b, TMP_3, self = this, parents = nil, parent = nil;

          if (expression == null) {
            expression = nil
          }
          if ((($a = self.$parent()) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new(self.$document())
          };
          parents = [self.$parent()];
          while ((($b = parent = parents.$last().$parent()) !== nil && (!$b._isBoolean || $b == true))) {
          parents['$<<'](parent)};
          if ((($a = (($b = $scope.Document) == null ? $opal.cm('Document') : $b)['$==='](parents.$last())) !== nil && (!$a._isBoolean || $a == true))) {
            parents.$pop()};
          if (expression !== false && expression !== nil) {
            ($a = ($b = parents)['$select!'], $a._p = (TMP_3 = function(p){var self = TMP_3._s || this;
if (p == null) p = nil;
            return p['$matches?'](expression)}, TMP_3._s = self, TMP_3), $a).call($b)};
          return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new(self.$document(), parents);
        };

        $opal.defn(self, '$before', def.$add_previous_sibling);

        def.$remove = function() {
          var $a, self = this;

          if ((($a = self.$parent()) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$parent().$remove_child(self)
            } else {
            return nil
          };
        };

        def.$clear = function() {
          var $a, $b, self = this;

          return ($a = ($b = self.$children()).$each, $a._p = "remove".$to_proc(), $a).call($b);
        };

        if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Element.textContent")) !== nil && (!$a._isBoolean || $a == true))) {
          def.$content = function() {
            var self = this;

            return self["native"].textContent;
          };

          def['$content='] = function(value) {
            var self = this;

            return self["native"].textContent = value;
          };
        } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Element.innerText")) !== nil && (!$a._isBoolean || $a == true))) {
          def.$content = function() {
            var self = this;

            return self["native"].innerText;
          };

          def['$content='] = function(value) {
            var self = this;

            return self["native"].innerText = value;
          };
          } else {
          def.$content = function() {
            var $a, self = this;

            return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "node text content unsupported");
          };

          def['$content='] = function(value) {
            var $a, self = this;

            return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "node text content unsupported");
          };
        };

        def['$blank?'] = function() {
          var $a, self = this;

          return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
        };

        def['$cdata?'] = function() {
          var $a, self = this;

          return self.$node_type()['$==']((($a = $scope.CDATA_SECTION_NODE) == null ? $opal.cm('CDATA_SECTION_NODE') : $a));
        };

        def.$child = function() {
          var self = this;

          return self.$children().$first();
        };

        def.$children = function() {
          var $a, $b, self = this;

          return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new(self.$document(), (($a = ((($b = $scope.Native) == null ? $opal.cm('Native') : $b))._scope).Array == null ? $a.cm('Array') : $a.Array).$new(self["native"].childNodes));
        };

        def['$children='] = function(node) {
          var $a, self = this;

          return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
        };

        def['$comment?'] = function() {
          var $a, self = this;

          return self.$node_type()['$==']((($a = $scope.COMMENT_NODE) == null ? $opal.cm('COMMENT_NODE') : $a));
        };

        def.$document = function() {
          var $a, self = this;

          if ((($a = (typeof(self["native"].ownerDocument) !== "undefined")) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$DOM(self["native"].ownerDocument)
            } else {
            return nil
          };
        };

        def['$document?'] = function() {
          var $a, self = this;

          return self.$node_type()['$==']((($a = $scope.DOCUMENT_NODE) == null ? $opal.cm('DOCUMENT_NODE') : $a));
        };

        def['$elem?'] = function() {
          var $a, self = this;

          return self.$node_type()['$==']((($a = $scope.ELEMENT_NODE) == null ? $opal.cm('ELEMENT_NODE') : $a));
        };

        $opal.defn(self, '$element?', def['$elem?']);

        def.$element_children = function() {
          var $a, $b, self = this;

          return ($a = ($b = self.$children()).$select, $a._p = "element?".$to_proc(), $a).call($b);
        };

        $opal.defn(self, '$elements', def.$element_children);

        def.$first_element_child = function() {
          var self = this;

          return self.$element_children().$first();
        };

        def['$fragment?'] = function() {
          var $a, self = this;

          return self.$node_type()['$==']((($a = $scope.DOCUMENT_FRAGMENT_NODE) == null ? $opal.cm('DOCUMENT_FRAGMENT_NODE') : $a));
        };

        def.$inner_html = function() {
          var self = this;

          return self["native"].innerHTML;
        };

        def['$inner_html='] = function(value) {
          var self = this;

          return self["native"].innerHTML = value;
        };

        $opal.defn(self, '$inner_text', def.$content);

        $opal.defn(self, '$inner_text=', def['$content=']);

        def.$last_element_child = function() {
          var self = this;

          return self.$element_children().$last();
        };

        def['$matches?'] = function(expression) {
          var self = this;

          return false;
        };

        def.$name = function() {
          var self = this;

          return self["native"].nodeName || nil;
        };

        def['$name='] = function(value) {
          var self = this;

          return self["native"].nodeName = value.$to_s();
        };

        def.$namespace = function() {
          var self = this;

          return self["native"].namespaceURI || nil;
        };

        def.$next = function() {
          var $a, self = this;

          if ((($a = self["native"].nextSibling != null) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$DOM(self["native"].nextSibling)
            } else {
            return nil
          };
        };

        $opal.defn(self, '$next=', def.$add_next_sibling);

        def.$next_element = function() {
          var $a, $b, $c, self = this, current = nil;

          current = self.$next();
          while ((($b = (($c = current !== false && current !== nil) ? current['$element?']()['$!']() : $c)) !== nil && (!$b._isBoolean || $b == true))) {
          current = current.$next()};
          return current;
        };

        $opal.defn(self, '$next_sibling', def.$next);

        $opal.defn(self, '$node_name', def.$name);

        $opal.defn(self, '$node_name=', def['$name=']);

        def.$node_type = function() {
          var self = this;

          return self["native"].nodeType;
        };

        def.$parent = function() {
          var $a, self = this;

          if ((($a = self["native"].parentNode != null) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$DOM(self["native"].parentNode)
            } else {
            return nil
          };
        };

        def['$parent='] = function(node) {
          var $a, self = this;

          return self["native"].parentNode = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$try_convert(node);
        };

        def.$parse = function(text, options) {
          var $a, self = this;

          if (options == null) {
            options = $hash2([], {})
          }
          return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
        };

        def.$path = function() {
          var $a, self = this;

          return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
        };

        def.$previous = function() {
          var $a, self = this;

          if ((($a = self["native"].previousSibling != null) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$DOM(self["native"].previousSibling)
            } else {
            return nil
          };
        };

        $opal.defn(self, '$previous=', def.$add_previous_sibling);

        def.$previous_element = function() {
          var $a, $b, $c, self = this, current = nil;

          current = self.$previous();
          while ((($b = (($c = current !== false && current !== nil) ? current['$element?']()['$!']() : $c)) !== nil && (!$b._isBoolean || $b == true))) {
          current = current.$previous()};
          return current;
        };

        $opal.defn(self, '$previous_sibling', def.$previous);

        def.$remove_child = function(node) {
          var $a, self = this;

          return self["native"].removeChild((($a = $scope.Native) == null ? $opal.cm('Native') : $a).$try_convert(node));
        };

        def.$replace = function(node) {
          var $a, self = this;

          self["native"].parentNode.replaceChild(self["native"], (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$try_convert(node));
          return node;
        };

        $opal.defn(self, '$text', def.$content);

        $opal.defn(self, '$text=', def['$content=']);

        def['$text?'] = function() {
          var $a, self = this;

          return self.$node_type()['$==']((($a = $scope.TEXT_NODE) == null ? $opal.cm('TEXT_NODE') : $a));
        };

        def.$traverse = TMP_4 = function() {
          var $a, self = this, $iter = TMP_4._p, block = $iter || nil;

          TMP_4._p = null;
          return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
        };

        $opal.defn(self, '$type', def.$node_type);

        def.$value = function() {
          var self = this;

          return self["native"].nodeValue || nil;
        };

        def['$value='] = function(value) {
          var self = this;

          return self["native"].nodeValue = value;
        };

        return (def.$inspect = function() {
          var self = this;

          return "#<DOM::Node: " + (self.$name()) + ">";
        }, nil) && 'inspect';
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/node.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$include']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Attribute(){};
        var self = $Attribute = $klass($base, $super, 'Attribute', $Attribute);

        var def = self._proto, $scope = self._scope, $a;

        def["native"] = nil;
        self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

        def['$id?'] = function() {
          var self = this;

          return self["native"].isId;
        };

        def.$name = function() {
          var self = this;

          return self["native"].name;
        };

        return (def.$value = function() {
          var self = this;

          return self["native"].value;
        }, nil) && 'value';
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/attribute.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $CharacterData(){};
        var self = $CharacterData = $klass($base, $super, 'CharacterData', $CharacterData);

        var def = self._proto, $scope = self._scope;

        def["native"] = nil;
        def.$append = function(string) {
          var self = this;

          self["native"].appendData(string);
          return self;
        };

        def.$data = function() {
          var self = this;

          return self["native"].data;
        };

        def.$delete = function(count, offset) {
          var self = this;

          if (offset == null) {
            offset = 0
          }
          self["native"].deleteData(offset, count);
          return self;
        };

        def.$insert = function(string, offset) {
          var self = this;

          if (offset == null) {
            offset = 0
          }
          self["native"].insertData(offset, string);
          return self;
        };

        self.$alias_native("length");

        def.$replace = function(string, offset, count) {
          var self = this;

          if (offset == null) {
            offset = 0
          }
          if (count == null) {
            count = self["native"].length
          }
          self["native"].replaceData(offset, count, string);
          return self;
        };

        return (def.$substring = function(count, offset) {
          var self = this;

          if (offset == null) {
            offset = 0
          }
          return self["native"].substringData(offset, count);
        }, nil) && 'substring';
      })(self, (($a = $scope.Node) == null ? $opal.cm('Node') : $a))
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/character_data.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$create_text', '$DOM', '$data']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Text(){};
        var self = $Text = $klass($base, $super, 'Text', $Text);

        var def = self._proto, $scope = self._scope;

        def["native"] = nil;
        $opal.defs(self, '$create', function(args) {
          var $a, self = this;
          if ($gvars.document == null) $gvars.document = nil;

          args = $slice.call(arguments, 0);
          return ($a = $gvars.document).$create_text.apply($a, [].concat(args));
        });

        def.$whole = function() {
          var self = this;

          return self["native"].wholeText;
        };

        def.$split = function(offset) {
          var self = this;

          return self.$DOM(self["native"].splitText(offset));
        };

        return (def.$inspect = function() {
          var self = this;

          return "#<DOM::Text: " + (self.$data()) + ">";
        }, nil) && 'inspect';
      })(self, (($a = $scope.CharacterData) == null ? $opal.cm('CharacterData') : $a))
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/text.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$value']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $CDATA(){};
        var self = $CDATA = $klass($base, $super, 'CDATA', $CDATA);

        var def = self._proto, $scope = self._scope;

        return (def.$inspect = function() {
          var self = this;

          return "#<DOM::CDATA: " + (self.$value()) + ">";
        }, nil) && 'inspect'
      })(self, (($a = $scope.Text) == null ? $opal.cm('Text') : $a))
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/cdata.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$value']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Comment(){};
        var self = $Comment = $klass($base, $super, 'Comment', $Comment);

        var def = self._proto, $scope = self._scope;

        return (def.$inspect = function() {
          var self = this;

          return "#<DOM::Comment: " + (self.$value()) + ">";
        }, nil) && 'inspect'
      })(self, (($a = $scope.CharacterData) == null ? $opal.cm('CharacterData') : $a))
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/comment.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$to_n', '$offset', '$get', '$parent', '$new', '$==', '$[]', '$style', '$=~', '$x=', '$+', '$x', '$to_i', '$y=', '$y', '$-']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope;

        return (function($base, $super) {
          function $Position(){};
          var self = $Position = $klass($base, $super, 'Position', $Position);

          var def = self._proto, $scope = self._scope;

          def.element = nil;
          def.$initialize = function(element) {
            var self = this;

            self.element = element;
            return self["native"] = element.$to_n();
          };

          def.$get = function() {
            var $a, $b, self = this, offset = nil, position = nil, parent = nil, parent_offset = nil;

            offset = self.element.$offset();
            position = offset.$get();
            parent = offset.$parent();
            parent_offset = (($a = ((($b = $scope.Browser) == null ? $opal.cm('Browser') : $b))._scope).Position == null ? $a.cm('Position') : $a.Position).$new(0, 0);
            if (self.element.$style()['$[]']("position")['$==']("fixed")) {
              if ((($a = parent['$=~']("html")) !== nil && (!$a._isBoolean || $a == true))) {
                } else {
                parent_offset = parent.$offset()
              };
              ($a = parent_offset, $a['$x=']($a.$x()['$+'](parent.$style()['$[]']("border-top-width").$to_i())));
              ($a = parent_offset, $a['$y=']($a.$y()['$+'](parent.$style()['$[]']("border-left-width").$to_i())));};
            return (($a = ((($b = $scope.Browser) == null ? $opal.cm('Browser') : $b))._scope).Position == null ? $a.cm('Position') : $a.Position).$new(position.$x()['$-'](parent_offset.$x())['$-'](self.element.$style()['$[]']("margin-left").$to_i()), position.$y()['$-'](parent_offset.$y())['$-'](self.element.$style()['$[]']("margin-top").$to_i()));
          };

          def.$x = function() {
            var self = this;

            return self.$get().$x();
          };

          return (def.$y = function() {
            var self = this;

            return self.$get().$y();
          }, nil) && 'y';
        })(self, null)
      })(self, (($a = $scope.Node) == null ? $opal.cm('Node') : $a))
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/element/position.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$attr_reader', '$to_n', '$DOM', '$root', '$document', '$x', '$get', '$set', '$y', '$supports?', '$window', '$new', '$[]', '$style!', '$==', '$[]=', '$style', '$to_u', '$===', '$first', '$+', '$-', '$px']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope;

        return (function($base, $super) {
          function $Offset(){};
          var self = $Offset = $klass($base, $super, 'Offset', $Offset);

          var def = self._proto, $scope = self._scope, $a, $b;

          def["native"] = def.element = nil;
          self.$attr_reader("element");

          def.$initialize = function(element) {
            var self = this;

            self.element = element;
            return self["native"] = element.$to_n();
          };

          def.$parent = function() {
            var self = this;

            return self.$DOM(self["native"].offsetParent || self.element.$document().$root().$to_n());
          };

          def.$x = function() {
            var self = this;

            return self.$get().$x();
          };

          def['$x='] = function(value) {
            var self = this;

            return self.$set(value, nil);
          };

          def.$y = function() {
            var self = this;

            return self.$get().$y();
          };

          def['$y='] = function(value) {
            var self = this;

            return self.$set(nil, value);
          };

          if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Element.getBoundingClientRect")) !== nil && (!$a._isBoolean || $a == true))) {
            def.$get = function() {
              var $a, $b, self = this, doc = nil, root = nil, win = nil;

              doc = self.element.$document();
              root = doc.$root().$to_n();
              win = doc.$window().$to_n();
              
        var box = self["native"].getBoundingClientRect(),
            y   = box.top + (win.pageYOffset || root.scrollTop) - (root.clientTop || 0),
            x   = box.left + (win.pageXOffset || root.scrollLeft) - (root.clientLeft || 0);
      ;
              return (($a = ((($b = $scope.Browser) == null ? $opal.cm('Browser') : $b))._scope).Position == null ? $a.cm('Position') : $a.Position).$new(x, y);
            }
            } else {
            def.$get = function() {
              var $a, $b, self = this, doc = nil, root = nil, win = nil;

              doc = self.$document();
              root = doc.$root().$to_n();
              win = doc.$window().$to_n();
              
        var y = (win.pageYOffset || root.scrollTop) - (root.clientTop || 0),
            x = (win.pageXOffset || root.scrollLeft) - (root.clientLeft || 0);
      ;
              return (($a = ((($b = $scope.Browser) == null ? $opal.cm('Browser') : $b))._scope).Position == null ? $a.cm('Position') : $a.Position).$new(x, y);
            }
          };

          return (def.$set = function(value) {
            var $a, $b, $c, self = this, position = nil, offset = nil, top = nil, left = nil, x = nil, y = nil;

            value = $slice.call(arguments, 0);
            position = self.element['$style!']()['$[]']("position");
            if (position['$==']("static")) {
              self.element.$style()['$[]=']("position", "relative")};
            offset = self.$get();
            top = self.element['$style!']()['$[]']("top").$to_u();
            left = self.element['$style!']()['$[]']("left").$to_u();
            if ((($a = (($b = ((($c = $scope.Browser) == null ? $opal.cm('Browser') : $c))._scope).Position == null ? $b.cm('Position') : $b.Position)['$==='](value.$first())) !== nil && (!$a._isBoolean || $a == true))) {
              $a = [value.$first().$x(), value.$first().$y()], x = $a[0], y = $a[1]
            } else if ((($a = (($b = $scope.Hash) == null ? $opal.cm('Hash') : $b)['$==='](value.$first())) !== nil && (!$a._isBoolean || $a == true))) {
              $a = [value.$first()['$[]']("x"), value.$first()['$[]']("y")], x = $a[0], y = $a[1]
              } else {
              $a = $opal.to_ary(value), x = ($a[0] == null ? nil : $a[0]), y = ($a[1] == null ? nil : $a[1])
            };
            if (x !== false && x !== nil) {
              self.element.$style()['$[]=']("left", (x.$px()['$-'](offset.$x()))['$+'](left))};
            if (y !== false && y !== nil) {
              return self.element.$style()['$[]=']("top", (y.$px()['$-'](offset.$y()))['$+'](top))
              } else {
              return nil
            };
          }, nil) && 'set';
        })(self, null)
      })(self, (($a = $scope.Node) == null ? $opal.cm('Node') : $a))
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/element/offset.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$to_n', '$supports?', '$[]', '$x', '$y', '$new', '$raise', '$position']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope;

        return (function($base, $super) {
          function $Scroll(){};
          var self = $Scroll = $klass($base, $super, 'Scroll', $Scroll);

          var def = self._proto, $scope = self._scope, $a, $b;

          def["native"] = nil;
          def.$initialize = function(element) {
            var self = this;

            self.element = element;
            return self["native"] = element.$to_n();
          };

          if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Element.scroll")) !== nil && (!$a._isBoolean || $a == true))) {
            def.$to = function(what) {
              var $a, self = this, x = nil, y = nil;

              x = ((($a = what['$[]']("x")) !== false && $a !== nil) ? $a : self.$x());
              y = ((($a = what['$[]']("y")) !== false && $a !== nil) ? $a : self.$y());
              self["native"].scrollTop  = y;
              return self["native"].scrollLeft = x;
            };

            def.$position = function() {
              var $a, $b, self = this;

              return (($a = ((($b = $scope.Browser) == null ? $opal.cm('Browser') : $b))._scope).Position == null ? $a.cm('Position') : $a.Position).$new(self["native"].scrollLeft, self["native"].scrollTop);
            };
          } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Element.pageOffset")) !== nil && (!$a._isBoolean || $a == true))) {
            def.$to = function(what) {
              var $a, self = this, x = nil, y = nil;

              x = ((($a = what['$[]']("x")) !== false && $a !== nil) ? $a : self.$x());
              y = ((($a = what['$[]']("y")) !== false && $a !== nil) ? $a : self.$y());
              self["native"].pageYOffset = y;
              return self["native"].pageXOffset = x;
            };

            def.$position = function() {
              var $a, self = this;

              return (($a = $scope.Position) == null ? $opal.cm('Position') : $a).$new(self["native"].pageXOffset, self["native"].pageYOffset);
            };
            } else {
            def.$to = function(what) {
              var $a, self = this;

              return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "scroll on element unsupported");
            };

            def.$position = function() {
              var $a, self = this;

              return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "scroll on element unsupported");
            };
          };

          def.$x = function() {
            var self = this;

            return self.$position().$x();
          };

          def.$y = function() {
            var self = this;

            return self.$position().$y();
          };

          def.$height = function() {
            var self = this;

            return self["native"].scrollHeight;
          };

          def.$width = function() {
            var self = this;

            return self["native"].scrollWidth;
          };

          return (def.$by = function(what) {
            var $a, self = this, x = nil, y = nil;

            x = ((($a = what['$[]']("x")) !== false && $a !== nil) ? $a : 0);
            y = ((($a = what['$[]']("y")) !== false && $a !== nil) ? $a : 0);
            self["native"].scrollBy(x, y);
            return self;
          }, nil) && 'by';
        })(self, null)
      })(self, (($a = $scope.Node) == null ? $opal.cm('Node') : $a))
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/element/scroll.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$attr_reader', '$to_n', '$[]=', '$style']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope;

        return (function($base, $super) {
          function $Size(){};
          var self = $Size = $klass($base, $super, 'Size', $Size);

          var def = self._proto, $scope = self._scope;

          def["native"] = def.element = nil;
          self.$attr_reader("element");

          def.$initialize = function(element, inc) {
            var self = this;

            inc = $slice.call(arguments, 1);
            self.element = element;
            self["native"] = element.$to_n();
            return self.include = inc;
          };

          def.$width = function() {
            var self = this;

            return self["native"].offsetWidth;
          };

          def['$width='] = function(value) {
            var self = this;

            return self.element.$style()['$[]=']("width", value);
          };

          def.$height = function() {
            var self = this;

            return self["native"].offsetHeight;
          };

          return (def['$height='] = function(value) {
            var self = this;

            return self.element.$style()['$[]=']("height", value);
          }, nil) && 'height=';
        })(self, null)
      })(self, (($a = $scope.Node) == null ? $opal.cm('Node') : $a))
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/element/size.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs([]);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Input(){};
          var self = $Input = $klass($base, $super, 'Input', $Input);

          var def = self._proto, $scope = self._scope;

          def["native"] = nil;
          def.$value = function() {
            var self = this;

            return self["native"].value;
          };

          def['$value='] = function(value) {
            var self = this;

            return self["native"].value = value;
          };

          return (def.$clear = function() {
            var self = this;

            return self["native"].value = '';
          }, nil) && 'clear';
        })(self, (($a = $scope.Element) == null ? $opal.cm('Element') : $a))
      })(self, (($a = $scope.Node) == null ? $opal.cm('Node') : $a))
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/element/input.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs([]);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope, $a;

        (function($base, $super) {
          function $Image(){};
          var self = $Image = $klass($base, $super, 'Image', $Image);

          var def = self._proto, $scope = self._scope;

          def["native"] = nil;
          def['$complete?'] = function() {
            var self = this;

            return self["native"].complete;
          };

          def['$cross?'] = function() {
            var self = this;

            return self["native"].crossOrigin;
          };

          def.$height = function() {
            var self = this;

            return self["native"].naturalHeight;
          };

          return (def.$width = function() {
            var self = this;

            return self["native"].naturalWidth;
          }, nil) && 'width';
        })(self, (($a = $scope.Element) == null ? $opal.cm('Element') : $a));

        return $opal.cdecl($scope, 'Img', (($a = $scope.Image) == null ? $opal.cm('Image') : $a));
      })(self, (($a = $scope.Node) == null ? $opal.cm('Node') : $a))
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/element/image.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $gvars = $opal.gvars, $hash2 = $opal.hash2;

  $opal.add_stubs(['$create_element', '$==', '$capitalize', '$const_defined?', '$new', '$const_get', '$include', '$target', '$DOM', '$alias_native', '$+', '$class_names', '$empty?', '$join', '$uniq', '$-', '$reject', '$to_proc', '$split', '$[]', '$to_s', '$!', '$attributes_nodesmap', '$map', '$attribute_nodes', '$height', '$size', '$height=', '$width', '$width=', '$set', '$offset', '$document', '$clear', '$<<', '$flatten', '$xpath', '$first', '$css', '$each', '$concat', '$to_a', '$supports?', '$loaded?', '$raise', '$is_a?', '$replace', '$assign', '$apply', '$to_n', '$window', '$===', '$name', '$attr_reader', '$enum_for', '$value', '$get_attribute', '$set_attribute', '$[]=']);
  ;
  ;
  ;
  ;
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Element(){};
        var self = $Element = $klass($base, $super, 'Element', $Element);

        var def = self._proto, $scope = self._scope, TMP_1, $a, $b, TMP_2, TMP_4, $c, $d, TMP_9;

        def["native"] = nil;
        $opal.defs(self, '$create', function(args) {
          var $a, self = this;
          if ($gvars.document == null) $gvars.document = nil;

          args = $slice.call(arguments, 0);
          return ($a = $gvars.document).$create_element.apply($a, [].concat(args));
        });

        $opal.defs(self, '$new', TMP_1 = function(node) {var $zuper = $slice.call(arguments, 0);
          var $a, $b, self = this, $iter = TMP_1._p, $yield = $iter || nil, name = nil;

          TMP_1._p = null;
          if (self['$==']((($a = $scope.Element) == null ? $opal.cm('Element') : $a))) {
            name = (node.nodeName).$capitalize();
            if ((($a = (($b = $scope.Element) == null ? $opal.cm('Element') : $b)['$const_defined?'](name)) !== nil && (!$a._isBoolean || $a == true))) {
              return (($a = $scope.Element) == null ? $opal.cm('Element') : $a).$const_get(name).$new(node)
              } else {
              return $opal.find_super_dispatcher(self, 'new', TMP_1, $iter, $Element).apply(self, $zuper)
            };
            } else {
            return $opal.find_super_dispatcher(self, 'new', TMP_1, $iter, $Element).apply(self, $zuper)
          };
        });

        self.$include((($a = ((($b = $scope.Event) == null ? $opal.cm('Event') : $b))._scope).Target == null ? $a.cm('Target') : $a.Target));

        ($a = ($b = self).$target, $a._p = (TMP_2 = function(value){var self = TMP_2._s || this;
if (value == null) value = nil;
        try {return self.$DOM(value) } catch ($err) { return nil }}, TMP_2._s = self, TMP_2), $a).call($b);

        self.$alias_native("id");

        def.$add_class = function(names) {
          var $a, self = this, classes = nil;

          names = $slice.call(arguments, 0);
          classes = self.$class_names()['$+'](names);
          if ((($a = classes['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            self["native"].className = classes.$uniq().$join(" ");
          };
          return self;
        };

        def.$remove_class = function(names) {
          var $a, self = this, classes = nil;

          names = $slice.call(arguments, 0);
          classes = self.$class_names()['$-'](names);
          if ((($a = classes['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
            self["native"].removeAttribute('class');
            } else {
            self["native"].className = classes.$join(" ");
          };
          return self;
        };

        self.$alias_native("class_name", "className");

        def.$class_names = function() {
          var $a, $b, self = this;

          return ($a = ($b = (self["native"].className).$split(/\s+/)).$reject, $a._p = "empty?".$to_proc(), $a).call($b);
        };

        $opal.defn(self, '$attribute', def.$attr);

        def.$attribute_nodes = function() {
          var $a, $b, TMP_3, $c, $d, self = this;

          return ($a = ($b = (($c = ((($d = $scope.Native) == null ? $opal.cm('Native') : $d))._scope).Array == null ? $c.cm('Array') : $c.Array)).$new, $a._p = (TMP_3 = function(e){var self = TMP_3._s || this;
if (e == null) e = nil;
          return self.$DOM(e)}, TMP_3._s = self, TMP_3), $a).call($b, self["native"].attributes, $hash2(["get"], {"get": "item"}));
        };

        def.$attributes = function(options) {
          var $a, self = this;

          if (options == null) {
            options = $hash2([], {})
          }
          return (($a = $scope.Attributes) == null ? $opal.cm('Attributes') : $a).$new(self, options);
        };

        def.$get = function(name, options) {
          var $a, self = this, namespace = nil;

          if (options == null) {
            options = $hash2([], {})
          }
          if ((($a = namespace = options['$[]']("namespace")) !== nil && (!$a._isBoolean || $a == true))) {
            return self["native"].getAttributeNS(namespace.$to_s(), name.$to_s()) || nil;
            } else {
            return self["native"].getAttribute(name.$to_s()) || nil;
          };
        };

        def.$set = function(name, value, options) {
          var $a, self = this, namespace = nil;

          if (options == null) {
            options = $hash2([], {})
          }
          if ((($a = namespace = options['$[]']("namespace")) !== nil && (!$a._isBoolean || $a == true))) {
            return self["native"].setAttributeNS(namespace.$to_s(), name.$to_s(), value);
            } else {
            return self["native"].setAttribute(name.$to_s(), value.$to_s());
          };
        };

        $opal.defn(self, '$[]', def.$get);

        $opal.defn(self, '$[]=', def.$set);

        $opal.defn(self, '$attr', def.$get);

        $opal.defn(self, '$attribute', def.$get);

        $opal.defn(self, '$get_attribute', def.$get);

        $opal.defn(self, '$set_attribute', def.$set);

        def['$key?'] = function(name) {
          var self = this;

          return self['$[]'](name)['$!']()['$!']();
        };

        def.$keys = function() {
          var $a, $b, self = this;

          return ($a = ($b = self).$attributes_nodesmap, $a._p = "name".$to_proc(), $a).call($b);
        };

        def.$values = function() {
          var $a, $b, self = this;

          return ($a = ($b = self.$attribute_nodes()).$map, $a._p = "value".$to_proc(), $a).call($b);
        };

        def.$remove_attribute = function(name) {
          var self = this;

          return self["native"].removeAttribute(name);
        };

        def.$size = function(inc) {
          var $a, $b, self = this;

          inc = $slice.call(arguments, 0);
          return ($a = (($b = $scope.Size) == null ? $opal.cm('Size') : $b)).$new.apply($a, [self].concat(inc));
        };

        def.$height = function() {
          var self = this;

          return self.$size().$height();
        };

        def['$height='] = function(value) {
          var self = this;

          return self.$size()['$height='](value);
        };

        def.$width = function() {
          var self = this;

          return self.$size().$width();
        };

        def['$width='] = function(value) {
          var self = this;

          return self.$size()['$width='](value);
        };

        def.$position = function() {
          var $a, self = this;

          return (($a = $scope.Position) == null ? $opal.cm('Position') : $a).$new(self);
        };

        def.$offset = function(values) {
          var $a, self = this, off = nil;

          values = $slice.call(arguments, 0);
          off = (($a = $scope.Offset) == null ? $opal.cm('Offset') : $a).$new(self);
          if ((($a = values['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            ($a = off).$set.apply($a, [].concat(values))
          };
          return off;
        };

        def['$offset='] = function(value) {
          var $a, self = this;

          return ($a = self.$offset()).$set.apply($a, [].concat(value));
        };

        def.$scroll = function() {
          var $a, self = this;

          return (($a = $scope.Scroll) == null ? $opal.cm('Scroll') : $a).$new(self);
        };

        def.$inner_dom = TMP_4 = function() {
          var $a, $b, $c, self = this, $iter = TMP_4._p, block = $iter || nil, doc = nil;

          TMP_4._p = null;
          doc = self.$document();
          self.$clear();
          ($a = ($b = (($c = $scope.Builder) == null ? $opal.cm('Builder') : $c)).$new, $a._p = block.$to_proc(), $a).call($b, doc, self);
          return self;
        };

        def['$inner_dom='] = function(node) {
          var self = this;

          self.$clear();
          return self['$<<'](node);
        };

        def['$/'] = function(paths) {
          var $a, $b, TMP_5, self = this;

          paths = $slice.call(arguments, 0);
          return ($a = ($b = paths).$map, $a._p = (TMP_5 = function(path){var self = TMP_5._s || this;
if (path == null) path = nil;
          return self.$xpath(path)}, TMP_5._s = self, TMP_5), $a).call($b).$flatten().$uniq();
        };

        def.$at = function(path) {
          var $a, self = this;

          return ((($a = self.$xpath(path).$first()) !== false && $a !== nil) ? $a : self.$css(path).$first());
        };

        def.$at_css = function(rules) {try {

          var $a, $b, TMP_6, self = this;

          rules = $slice.call(arguments, 0);
          ($a = ($b = rules).$each, $a._p = (TMP_6 = function(rule){var self = TMP_6._s || this, found = nil;
if (rule == null) rule = nil;
          found = self.$css(rule).$first();
            if (found !== false && found !== nil) {
              $opal.$return(found)
              } else {
              return nil
            };}, TMP_6._s = self, TMP_6), $a).call($b);
          return nil;
          } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
        };

        def.$at_xpath = function(paths) {try {

          var $a, $b, TMP_7, self = this;

          paths = $slice.call(arguments, 0);
          ($a = ($b = paths).$each, $a._p = (TMP_7 = function(path){var self = TMP_7._s || this, found = nil;
if (path == null) path = nil;
          found = self.$xpath(path).$first();
            if (found !== false && found !== nil) {
              $opal.$return(found)
              } else {
              return nil
            };}, TMP_7._s = self, TMP_7), $a).call($b);
          return nil;
          } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
        };

        def.$search = function(selectors) {
          var $a, $b, TMP_8, self = this;

          selectors = $slice.call(arguments, 0);
          return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new(self.$document(), ($a = ($b = selectors).$map, $a._p = (TMP_8 = function(selector){var self = TMP_8._s || this;
if (selector == null) selector = nil;
          return self.$xpath(selector).$to_a().$concat(self.$css(selector).$to_a())}, TMP_8._s = self, TMP_8), $a).call($b).$flatten().$uniq());
        };

        if ((($a = (($c = $scope.Browser) == null ? $opal.cm('Browser') : $c)['$supports?']("Query.css")) !== nil && (!$a._isBoolean || $a == true))) {
          def.$css = function(path) {
            var $a, $b, self = this;

            
        try {
          var result = self["native"].querySelectorAll(path);

          return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new(self.$document(), (($a = ((($b = $scope.Native) == null ? $opal.cm('Native') : $b))._scope).Array == null ? $a.cm('Array') : $a.Array).$new(result));
        }
        catch(e) {
          return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new(self.$document());
        }
      ;
          }
        } else if ((($a = (($c = $scope.Browser) == null ? $opal.cm('Browser') : $c)['$loaded?']("Sizzle")) !== nil && (!$a._isBoolean || $a == true))) {
          def.$css = function(path) {
            var $a, self = this;

            return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new(self.$document(), Sizzle(path, self["native"]));
          }
          } else {
          def.$css = function(selector) {
            var $a, self = this;

            return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "query by CSS selector unsupported");
          }
        };

        if ((($a = ((($c = (($d = $scope.Browser) == null ? $opal.cm('Browser') : $d)['$supports?']("Query.xpath")) !== false && $c !== nil) ? $c : (($d = $scope.Browser) == null ? $opal.cm('Browser') : $d)['$loaded?']("wicked-good-xpath"))) !== nil && (!$a._isBoolean || $a == true))) {
          if ((($a = (($c = $scope.Browser) == null ? $opal.cm('Browser') : $c)['$loaded?']("wicked-good-xpath")) !== nil && (!$a._isBoolean || $a == true))) {
            wgxpath.install();};

          def.$xpath = function(path) {
            var $a, $b, self = this;

            
        try {
          var result = (self["native"].ownerDocument || self["native"]).evaluate(path,
            self["native"], null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);

          return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new(self.$document(), (($a = ((($b = $scope.Native) == null ? $opal.cm('Native') : $b))._scope).Array == null ? $a.cm('Array') : $a.Array).$new(result, $hash2(["get", "length"], {"get": "snapshotItem", "length": "snapshotLength"})));
        }
        catch (e) {
          return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new(self.$document());
        }
      ;
          };
          } else {
          def.$xpath = function(path) {
            var $a, self = this;

            return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "query by XPath unsupported");
          }
        };

        def.$style = TMP_9 = function(data) {
          var $a, $b, self = this, $iter = TMP_9._p, block = $iter || nil, style = nil;

          if (data == null) {
            data = nil
          }
          TMP_9._p = null;
          style = (($a = ((($b = $scope.CSS) == null ? $opal.cm('CSS') : $b))._scope).Declaration == null ? $a.cm('Declaration') : $a.Declaration).$new(self["native"].style);
          if ((($a = ((($b = data) !== false && $b !== nil) ? $b : block)) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            return style
          };
          if ((($a = data['$is_a?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            style.$replace(data)
          } else if ((($a = data['$is_a?']((($b = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            style.$assign(data)
          } else if (block !== false && block !== nil) {
            ($a = ($b = style).$apply, $a._p = block.$to_proc(), $a).call($b)};
          return self;
        };

        if ((($a = (($c = $scope.Browser) == null ? $opal.cm('Browser') : $c)['$supports?']("CSS.computed")) !== nil && (!$a._isBoolean || $a == true))) {
          def['$style!'] = function() {
            var $a, $b, self = this;

            return (($a = ((($b = $scope.CSS) == null ? $opal.cm('CSS') : $b))._scope).Declaration == null ? $a.cm('Declaration') : $a.Declaration).$new(self.$window().$to_n().getComputedStyle(self["native"], null));
          }
        } else if ((($a = (($c = $scope.Browser) == null ? $opal.cm('Browser') : $c)['$supports?']("CSS.current")) !== nil && (!$a._isBoolean || $a == true))) {
          def['$style!'] = function() {
            var $a, $b, self = this;

            return (($a = ((($b = $scope.CSS) == null ? $opal.cm('CSS') : $b))._scope).Declaration == null ? $a.cm('Declaration') : $a.Declaration).$new(self["native"].currentStyle);
          }
          } else {
          def['$style!'] = function() {
            var $a, self = this;

            return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "computed style unsupported");
          }
        };

        def.$data = function(what) {
          var $a, $b, TMP_10, self = this;

          if ((($a = (($b = $scope.Hash) == null ? $opal.cm('Hash') : $b)['$==='](what)) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = (typeof(self["native"].$data) !== "undefined")) !== nil && (!$a._isBoolean || $a == true))) {
              } else {
              self["native"].$data = {};
            };
            return ($a = ($b = what).$each, $a._p = (TMP_10 = function(name, value){var self = TMP_10._s || this;
              if (self["native"] == null) self["native"] = nil;
if (name == null) name = nil;if (value == null) value = nil;
            return self["native"].$data[name] = value;}, TMP_10._s = self, TMP_10), $a).call($b);
            } else {
            if ((($a = self['$[]']("data-" + (what))) !== nil && (!$a._isBoolean || $a == true))) {
              return self['$[]']("data-" + (what))};
            if ((($a = (typeof(self["native"].$data) !== "undefined")) !== nil && (!$a._isBoolean || $a == true))) {
              } else {
              return nil
            };
            
        var value = self["native"].$data[what];

        if (value === undefined) {
          return nil;
        }
        else {
          return value;
        }
      ;
          };
        };

        if ((($a = (($c = $scope.Browser) == null ? $opal.cm('Browser') : $c)['$supports?']("Element.matches")) !== nil && (!$a._isBoolean || $a == true))) {
          def['$matches?'] = function(selector) {
            var self = this;

            return self["native"].matches(selector);
          }
        } else if ((($a = (($c = $scope.Browser) == null ? $opal.cm('Browser') : $c)['$supports?']("Element.matches (Opera)")) !== nil && (!$a._isBoolean || $a == true))) {
          def['$matches?'] = function(selector) {
            var self = this;

            return self["native"].oMatchesSelector(selector);
          }
        } else if ((($a = (($c = $scope.Browser) == null ? $opal.cm('Browser') : $c)['$supports?']("Element.matches (Internet Explorer)")) !== nil && (!$a._isBoolean || $a == true))) {
          def['$matches?'] = function(selector) {
            var self = this;

            return self["native"].msMatchesSelector(selector);
          }
        } else if ((($a = (($c = $scope.Browser) == null ? $opal.cm('Browser') : $c)['$supports?']("Element.matches (Firefox)")) !== nil && (!$a._isBoolean || $a == true))) {
          def['$matches?'] = function(selector) {
            var self = this;

            return self["native"].mozMatchesSelector(selector);
          }
        } else if ((($a = (($c = $scope.Browser) == null ? $opal.cm('Browser') : $c)['$supports?']("Element.matches (Chrome)")) !== nil && (!$a._isBoolean || $a == true))) {
          def['$matches?'] = function(selector) {
            var self = this;

            return self["native"].webkitMatchesSelector(selector);
          }
        } else if ((($a = (($c = $scope.Browser) == null ? $opal.cm('Browser') : $c)['$loaded?']("Sizzle")) !== nil && (!$a._isBoolean || $a == true))) {
          def['$matches?'] = function(selector) {
            var self = this;

            return Sizzle.matchesSelector(self["native"], selector);
          }
          } else {
          def['$matches?'] = function(selector) {
            var $a, self = this;

            return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "selector matching unsupported");
          }
        };

        def.$window = function() {
          var self = this;

          return self.$document().$window();
        };

        def.$inspect = function() {
          var self = this;

          return "#<DOM::Element: " + (self.$name()) + ">";
        };

        return (function($base, $super) {
          function $Attributes(){};
          var self = $Attributes = $klass($base, $super, 'Attributes', $Attributes);

          var def = self._proto, $scope = self._scope, $a, TMP_11;

          def.element = def.namespace = nil;
          self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

          self.$attr_reader("namespace");

          def.$initialize = function(element, options) {
            var self = this;

            self.element = element;
            return self.namespace = options['$[]']("namespace");
          };

          def.$each = TMP_11 = function() {
            var $a, $b, TMP_12, self = this, $iter = TMP_11._p, block = $iter || nil;

            TMP_11._p = null;
            if ((block !== nil)) {
              } else {
              return self.$enum_for("each")
            };
            ($a = ($b = self.element.$attribute_nodes()).$each, $a._p = (TMP_12 = function(attr){var self = TMP_12._s || this, $a;
if (attr == null) attr = nil;
            return $a = $opal.$yieldX(block, [attr.$name(), attr.$value()]), $a === $breaker ? $a : $a}, TMP_12._s = self, TMP_12), $a).call($b);
            return self;
          };

          def['$[]'] = function(name) {
            var self = this;

            return self.element.$get_attribute(name, $hash2(["namespace"], {"namespace": self.namespace}));
          };

          def['$[]='] = function(name, value) {
            var self = this;

            return self.element.$set_attribute(name, value, $hash2(["namespace"], {"namespace": self.namespace}));
          };

          return (def['$merge!'] = function(hash) {
            var $a, $b, TMP_13, self = this;

            ($a = ($b = hash).$each, $a._p = (TMP_13 = function(name, value){var self = TMP_13._s || this;
if (name == null) name = nil;if (value == null) value = nil;
            return self['$[]='](name, value)}, TMP_13._s = self, TMP_13), $a).call($b);
            return self;
          }, nil) && 'merge!';
        })(self, null);
      })(self, (($a = $scope.Node) == null ? $opal.cm('Node') : $a))
      
    })(self)
    
  })(self);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/element.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$to_s', '$alias_native', '$new']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope, $a, $b;

    (function($base, $super) {
      function $Location(){};
      var self = $Location = $klass($base, $super, 'Location', $Location);

      var def = self._proto, $scope = self._scope, $a;

      def["native"] = nil;
      self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

      def.$assign = function(url) {
        var self = this;

        return self["native"].assign(url.$to_s());
      };

      def.$replace = function(url) {
        var self = this;

        return self["native"].replace(url.$to_s());
      };

      def.$reload = function(force) {
        var self = this;

        if (force == null) {
          force = false
        }
        return self["native"].reload(force);
      };

      def.$to_s = function() {
        var self = this;

        return self["native"].toString();
      };

      self.$alias_native("fragment", "hash");

      self.$alias_native("fragment=", "hash=");

      self.$alias_native("host");

      self.$alias_native("host=");

      self.$alias_native("uri", "href");

      self.$alias_native("uri=", "href=");

      self.$alias_native("path", "pathname");

      self.$alias_native("path=", "pathname=");

      self.$alias_native("port");

      self.$alias_native("port=");

      self.$alias_native("scheme", "protocol");

      self.$alias_native("scheme=", "protocol=");

      self.$alias_native("query", "search");

      return self.$alias_native("query=", "search=");
    })(self, null);

    (function($base, $super) {
      function $Window(){};
      var self = $Window = $klass($base, $super, 'Window', $Window);

      var def = self._proto, $scope = self._scope;

      def["native"] = nil;
      return (def.$location = function() {
        var $a, self = this;

        if ((($a = self["native"].location) !== nil && (!$a._isBoolean || $a == true))) {
          return (($a = $scope.Location) == null ? $opal.cm('Location') : $a).$new(self["native"].location)
          } else {
          return nil
        };
      }, nil) && 'location'
    })(self, null);

    (function($base, $super) {
      function $Document(){};
      var self = $Document = $klass($base, $super, 'Document', $Document);

      var def = self._proto, $scope = self._scope;

      def["native"] = nil;
      return (def.$location = function() {
        var $a, self = this;

        if ((($a = self["native"].location) !== nil && (!$a._isBoolean || $a == true))) {
          return (($a = $scope.Location) == null ? $opal.cm('Location') : $a).$new(self["native"].location)
          } else {
          return nil
        };
      }, nil) && 'location'
    })((($a = $scope.DOM) == null ? $opal.cm('DOM') : $a), (($a = ((($b = $scope.DOM) == null ? $opal.cm('DOM') : $b))._scope).Element == null ? $a.cm('Element') : $a.Element));
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/location.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$[]', '$DOM', '$supports?', '$new', '$raise', '$first', '$css', '$xpath', '$inspect', '$children', '$convert']);
  ;
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Document(){};
        var self = $Document = $klass($base, $super, 'Document', $Document);

        var def = self._proto, $scope = self._scope, $a, $b;

        def["native"] = nil;
        def.$create_element = function(name, options) {
          var $a, self = this, ns = nil;

          if (options == null) {
            options = $hash2([], {})
          }
          if ((($a = ns = options['$[]']("namespace")) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$DOM(self["native"].createElementNS(ns, name))
            } else {
            return self.$DOM(self["native"].createElement(name))
          };
        };

        if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Document.view")) !== nil && (!$a._isBoolean || $a == true))) {
          def.$window = function() {
            var $a, self = this;

            return (($a = $scope.Window) == null ? $opal.cm('Window') : $a).$new(self["native"].defaultView);
          }
        } else if ((($a = (($b = $scope.Browser) == null ? $opal.cm('Browser') : $b)['$supports?']("Document.window")) !== nil && (!$a._isBoolean || $a == true))) {
          def.$window = function() {
            var $a, self = this;

            return (($a = $scope.Window) == null ? $opal.cm('Window') : $a).$new(self["native"].parentWindow);
          }
          } else {
          def.$window = function() {
            var $a, self = this;

            return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a), "window from document unsupported");
          }
        };

        def.$create_text = function(content) {
          var self = this;

          return self.$DOM(self["native"].createTextNode(content));
        };

        def['$[]'] = function(what) {
          var $a, self = this;

          
      var result = self["native"].getElementById(what);

      if (result) {
        return self.$DOM(result);
      }
    ;
          return ((($a = self.$css(what).$first()) !== false && $a !== nil) ? $a : self.$xpath(what).$first());
        };

        $opal.defn(self, '$at', def['$[]']);

        def.$document = function() {
          var self = this;

          return self;
        };

        def.$inspect = function() {
          var self = this;

          return "#<DOM::Document: " + (self.$children().$inspect()) + ">";
        };

        def.$title = function() {
          var self = this;

          return self["native"].title;
        };

        def['$title='] = function(value) {
          var self = this;

          return self["native"].title = value;
        };

        def.$root = function() {
          var self = this;

          return self.$DOM(self["native"].documentElement);
        };

        def.$head = function() {
          var self = this;

          return self.$DOM(self["native"].getElementsByTagName("head")[0]);
        };

        def.$body = function() {
          var self = this;

          return self.$DOM(self["native"].body);
        };

        def.$style_sheets = function() {
          var $a, $b, TMP_1, $c, $d, self = this;

          return ($a = ($b = (($c = ((($d = $scope.Native) == null ? $opal.cm('Native') : $d))._scope).Array == null ? $c.cm('Array') : $c.Array)).$new, $a._p = (TMP_1 = function(e){var self = TMP_1._s || this, $a, $b;
if (e == null) e = nil;
          return (($a = ((($b = $scope.CSS) == null ? $opal.cm('CSS') : $b))._scope).StyleSheet == null ? $a.cm('StyleSheet') : $a.StyleSheet).$new(e)}, TMP_1._s = self, TMP_1), $a).call($b, self["native"].styleSheets);
        };

        return (def['$root='] = function(element) {
          var $a, self = this;

          return self["native"].documentElement = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(element);
        }, nil) && 'root=';
      })(self, (($a = $scope.Element) == null ? $opal.cm('Element') : $a))
      
    })(self)
    
  })(self);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/document.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs([]);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $DocumentFragment(){};
        var self = $DocumentFragment = $klass($base, $super, 'DocumentFragment', $DocumentFragment);

        var def = self._proto, $scope = self._scope;

        return nil;
      })(self, (($a = $scope.Element) == null ? $opal.cm('Element') : $a))
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/document_fragment.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, $b, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$<<', '$[]=', '$to_h', '$[]', '$each', '$===', '$call', '$attr_reader', '$new', '$to_proc', '$map', '$build', '$for', '$create_text', '$document', '$create_element', '$merge!', '$attributes', '$add_class', '$on', '$inner_html=']);
  (function($base) {
    var self = $module($base, 'Utils');

    var def = self._proto, $scope = self._scope;

    $opal.defs(self, '$heredoc', function(string) {
      var self = this;

      return string;
    })
    
  })((($a = $scope.Paggio) == null ? $opal.cm('Paggio') : $a));
  (function($base, $super) {
    function $Element(){};
    var self = $Element = $klass($base, $super, 'Element', $Element);

    var def = self._proto, $scope = self._scope, TMP_1;

    def.on = nil;
    return (def.$on = TMP_1 = function(args) {
      var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_1._p = null;
      return (((($a = self.on) !== false && $a !== nil) ? $a : self.on = []))['$<<']([args, block]);
    }, nil) && 'on'
  })((($a = ((($b = $scope.Paggio) == null ? $opal.cm('Paggio') : $b))._scope).HTML == null ? $a.cm('HTML') : $a.HTML), (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a));
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope, $a, $b, TMP_7, $c, TMP_8, $d, $e, $f, TMP_12;

      (function($base, $super) {
        function $Builder(){};
        var self = $Builder = $klass($base, $super, 'Builder', $Builder);

        var def = self._proto, $scope = self._scope, TMP_2, TMP_4;

        def.builder = def.element = def.roots = nil;
        $opal.defs(self, '$to_h', function() {
          var $a, self = this;
          if (self.builders == null) self.builders = nil;

          return ((($a = self.builders) !== false && $a !== nil) ? $a : self.builders = $hash2([], {}));
        });

        $opal.defs(self, '$for', TMP_2 = function(klass) {
          var self = this, $iter = TMP_2._p, block = $iter || nil;

          TMP_2._p = null;
          if (block !== false && block !== nil) {
            return self.$to_h()['$[]='](klass, block)
            } else {
            return self.$to_h()['$[]'](klass)
          };
        });

        $opal.defs(self, '$build', function(builder, item) {
          var $a, $b, TMP_3, self = this;

          return ($a = ($b = self.$to_h()).$each, $a._p = (TMP_3 = function(klass, block){var self = TMP_3._s || this, $a;
if (klass == null) klass = nil;if (block == null) block = nil;
          if ((($a = klass['$==='](item)) !== nil && (!$a._isBoolean || $a == true))) {
              return ($breaker.$v = block.$call(builder, item), $breaker)
              } else {
              return nil
            }}, TMP_3._s = self, TMP_3), $a).call($b);
        });

        self.$attr_reader("document", "element");

        def.$initialize = TMP_4 = function(document, element) {
          var $a, $b, $c, $d, TMP_5, TMP_6, self = this, $iter = TMP_4._p, block = $iter || nil;

          if (element == null) {
            element = nil
          }
          TMP_4._p = null;
          self.document = document;
          self.element = element;
          self.builder = ($a = ($b = (($c = ((($d = $scope.Paggio) == null ? $opal.cm('Paggio') : $d))._scope).HTML == null ? $c.cm('HTML') : $c.HTML)).$new, $a._p = block.$to_proc(), $a).call($b);
          self.roots = ($a = ($c = self.builder.$each()).$map, $a._p = (TMP_5 = function(e){var self = TMP_5._s || this, $a;
if (e == null) e = nil;
          return (($a = $scope.Builder) == null ? $opal.cm('Builder') : $a).$build(self, e)}, TMP_5._s = self, TMP_5), $a).call($c);
          if ((($a = self.element) !== nil && (!$a._isBoolean || $a == true))) {
            return ($a = ($d = self.roots).$each, $a._p = (TMP_6 = function(root){var self = TMP_6._s || this;
              if (self.element == null) self.element = nil;
if (root == null) root = nil;
            return self.element['$<<'](root)}, TMP_6._s = self, TMP_6), $a).call($d)
            } else {
            return nil
          };
        };

        return (def.$to_a = function() {
          var self = this;

          return self.roots;
        }, nil) && 'to_a';
      })(self, null);

      ($a = ($b = (($c = $scope.Builder) == null ? $opal.cm('Builder') : $c)).$for, $a._p = (TMP_7 = function(b, item){var self = TMP_7._s || this;
if (b == null) b = nil;if (item == null) item = nil;
      return b.$document().$create_text(item)}, TMP_7._s = self, TMP_7), $a).call($b, (($c = $scope.String) == null ? $opal.cm('String') : $c));

      ($a = ($c = (($d = $scope.Builder) == null ? $opal.cm('Builder') : $d)).$for, $a._p = (TMP_8 = function(b, item){var self = TMP_8._s || this, $a, $b, TMP_9, $c, TMP_10, $d, TMP_11, dom = nil, on = nil, inner = nil;
if (b == null) b = nil;if (item == null) item = nil;
      dom = b.$document().$create_element(item.name);
        if ((($a = (($b = $scope.Hash) == null ? $opal.cm('Hash') : $b)['$==='](item.attributes)) !== nil && (!$a._isBoolean || $a == true))) {
          dom.$attributes()['$merge!'](item.attributes)};
        ($a = ($b = (item.class_names)).$each, $a._p = (TMP_9 = function(value){var self = TMP_9._s || this;
if (value == null) value = nil;
        return dom.$add_class(value)}, TMP_9._s = self, TMP_9), $a).call($b);
        if ((($a = on = item.on || nil) !== nil && (!$a._isBoolean || $a == true))) {
          ($a = ($c = on).$each, $a._p = (TMP_10 = function(args, block){var self = TMP_10._s || this, $a, $b;
if (args == null) args = nil;if (block == null) block = nil;
          return ($a = ($b = dom).$on, $a._p = block.$to_proc(), $a).apply($b, [].concat(args))}, TMP_10._s = self, TMP_10), $a).call($c)};
        if ((($a = inner = item.inner_html || nil) !== nil && (!$a._isBoolean || $a == true))) {
          dom['$inner_html='](inner)
          } else {
          ($a = ($d = item).$each, $a._p = (TMP_11 = function(child){var self = TMP_11._s || this, $a;
if (child == null) child = nil;
          return dom['$<<']((($a = $scope.Builder) == null ? $opal.cm('Builder') : $a).$build(b, child))}, TMP_11._s = self, TMP_11), $a).call($d)
        };
        return dom;}, TMP_8._s = self, TMP_8), $a).call($c, (($d = ((($e = ((($f = $scope.Paggio) == null ? $opal.cm('Paggio') : $f))._scope).HTML == null ? $e.cm('HTML') : $e.HTML))._scope).Element == null ? $d.cm('Element') : $d.Element));

      ($a = ($d = (($e = $scope.Builder) == null ? $opal.cm('Builder') : $e)).$for, $a._p = (TMP_12 = function(b, item){var self = TMP_12._s || this;
if (b == null) b = nil;if (item == null) item = nil;
      return item}, TMP_12._s = self, TMP_12), $a).call($d, (($e = ((($f = $scope.DOM) == null ? $opal.cm('DOM') : $f))._scope).Node == null ? $e.cm('Node') : $e.Node));
      
    })(self)
    
  })(self);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/builder.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $gvars = $opal.gvars, $hash2 = $opal.hash2;

  $opal.add_stubs(['$supports?', '$include', '$===', '$==', '$type', '$new', '$DOM', '$alias_native', '$call', '$map', '$convert', '$private', '$Native', '$[]', '$[]=', '$to_n']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'DOM');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $MutationObserver(){};
        var self = $MutationObserver = $klass($base, $super, 'MutationObserver', $MutationObserver);

        var def = self._proto, $scope = self._scope, $a, TMP_1;

        def["native"] = nil;
        $opal.defs(self, '$supported?', function() {
          var $a, self = this;

          return (($a = $scope.Browser) == null ? $opal.cm('Browser') : $a)['$supports?']("MutationObserver");
        });

        self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

        (function($base, $super) {
          function $Record(){};
          var self = $Record = $klass($base, $super, 'Record', $Record);

          var def = self._proto, $scope = self._scope, $a;

          def["native"] = nil;
          self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

          def.$type = function() {
            var self = this, $case = nil;

            return (function() {$case = self["native"].type;if ("attributes"['$===']($case)) {return "attribute"}else if ("childList"['$===']($case)) {return "tree"}else if ("characterData"['$===']($case)) {return "cdata"}else { return nil }})();
          };

          def['$attribute?'] = function() {
            var self = this;

            return self.$type()['$==']("attribute");
          };

          def['$tree?'] = function() {
            var self = this;

            return self.$type()['$==']("tree");
          };

          def['$cdata?'] = function() {
            var self = this;

            return self.$type()['$==']("cdata");
          };

          def.$added = function() {
            var $a, $b, self = this, array = nil;
            if ($gvars.document == null) $gvars.document = nil;

            array = (function() {if ((($a = self["native"].addedNodes != null) !== nil && (!$a._isBoolean || $a == true))) {
              return (($a = ((($b = $scope.Native) == null ? $opal.cm('Native') : $b))._scope).Array == null ? $a.cm('Array') : $a.Array).$new(self["native"].addedNodes)
              } else {
              return []
            }; return nil; })();
            return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new($gvars.document, array);
          };

          def.$removed = function() {
            var $a, $b, self = this, array = nil;
            if ($gvars.document == null) $gvars.document = nil;

            array = (function() {if ((($a = self["native"].removedNodes != null) !== nil && (!$a._isBoolean || $a == true))) {
              return (($a = ((($b = $scope.Native) == null ? $opal.cm('Native') : $b))._scope).Array == null ? $a.cm('Array') : $a.Array).$new(self["native"].removedNodes)
              } else {
              return []
            }; return nil; })();
            return (($a = $scope.NodeSet) == null ? $opal.cm('NodeSet') : $a).$new($gvars.document, array);
          };

          def.$target = function() {
            var self = this;

            return self.$DOM(self["native"].target);
          };

          self.$alias_native("old", "oldValue");

          self.$alias_native("name", "attributeName");

          return self.$alias_native("namespace", "attributeNamespace");
        })(self, null);

        def.$initialize = TMP_1 = function() {
          var $a, $b, TMP_2, self = this, $iter = TMP_1._p, block = $iter || nil;

          TMP_1._p = null;
          
      var func = function(records) {
        return block.$call(($a = ($b = (records)).$map, $a._p = (TMP_2 = function(r){var self = TMP_2._s || this, $a, $b, $c, $d;
if (r == null) r = nil;
          return (($a = ((($b = ((($c = ((($d = $scope.Browser) == null ? $opal.cm('Browser') : $d))._scope).DOM == null ? $c.cm('DOM') : $c.DOM))._scope).MutationObserver == null ? $b.cm('MutationObserver') : $b.MutationObserver))._scope).Record == null ? $a.cm('Record') : $a.Record).$new(r)}, TMP_2._s = self, TMP_2), $a).call($b));
      }
    ;
          return $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new window.MutationObserver(func)]);
        };

        def.$observe = function(target, options) {
          var $a, self = this;

          if (options == null) {
            options = nil
          }
          if (options !== false && options !== nil) {
            } else {
            options = $hash2(["children", "tree", "attributes", "cdata"], {"children": true, "tree": true, "attributes": "old", "cdata": "old"})
          };
          self["native"].observe((($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(target), self.$convert(options));
          return self;
        };

        def.$take = function() {
          var $a, $b, TMP_3, self = this;

          return ($a = ($b = (self["native"].takeRecords())).$map, $a._p = (TMP_3 = function(r){var self = TMP_3._s || this, $a;
if (r == null) r = nil;
          return (($a = $scope.Record) == null ? $opal.cm('Record') : $a).$new(r)}, TMP_3._s = self, TMP_3), $a).call($b);
        };

        def.$disconnect = function() {
          var self = this;

          return self["native"].disconnect();
        };

        self.$private();

        return (def.$convert = function(hash) {
          var $a, self = this, options = nil, attrs = nil, filter = nil, cdata = nil;

          options = self.$Native({});
          if ((($a = hash['$[]']("children")) !== nil && (!$a._isBoolean || $a == true))) {
            options['$[]=']("childList", true)};
          if ((($a = hash['$[]']("tree")) !== nil && (!$a._isBoolean || $a == true))) {
            options['$[]=']("subtree", true)};
          if ((($a = attrs = hash['$[]']("attributes")) !== nil && (!$a._isBoolean || $a == true))) {
            options['$[]=']("attributes", true);
            if (attrs['$==']("old")) {
              options['$[]=']("attributeOldValue", true)};};
          if ((($a = filter = hash['$[]']("filter")) !== nil && (!$a._isBoolean || $a == true))) {
            options['$[]=']("attributeFilter", filter)};
          if ((($a = cdata = hash['$[]']("cdata")) !== nil && (!$a._isBoolean || $a == true))) {
            options['$[]=']("characterData", true);
            if (cdata['$==']("old")) {
              options['$[]=']("characterDataOldValue", true)};};
          return options.$to_n();
        }, nil) && 'convert';
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom/mutation_observer.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $gvars = $opal.gvars, $klass = $opal.klass;
  if ($gvars.window == null) $gvars.window = nil;

  $opal.add_stubs(['$DOM', '$shift', '$to_a', '$new', '$to_proc', '$==', '$length', '$first', '$native?', '$===', '$try_convert', '$raise', '$include', '$target', '$document']);
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  (function($base) {
    var self = $module($base, 'Kernel');

    var def = self._proto, $scope = self._scope, TMP_1;

    def.$XML = function(what) {
      var self = this;

      
      var doc;

      if (window.DOMParser) {
        doc = new DOMParser().parseFromString(what, 'text/xml');
      }
      else {
        doc       = new ActiveXObject('Microsoft.XMLDOM');
        doc.async = 'false';
        doc.loadXML(what);
      }
    
      return self.$DOM(doc);
    };

    def.$DOM = TMP_1 = function(args) {
      var $a, $b, $c, $d, $e, self = this, $iter = TMP_1._p, block = $iter || nil, document = nil, element = nil, roots = nil, what = nil;
      if ($gvars.document == null) $gvars.document = nil;

      args = $slice.call(arguments, 0);
      TMP_1._p = null;
      if (block !== false && block !== nil) {
        document = ((($a = args.$shift()) !== false && $a !== nil) ? $a : $gvars.document);
        element = args.$shift();
        roots = ($a = ($b = (($c = ((($d = ((($e = $scope.Browser) == null ? $opal.cm('Browser') : $e))._scope).DOM == null ? $d.cm('DOM') : $d.DOM))._scope).Builder == null ? $c.cm('Builder') : $c.Builder)).$new, $a._p = block.$to_proc(), $a).call($b, document, element).$to_a();
        if (roots.$length()['$=='](1)) {
          return roots.$first()
          } else {
          return (($a = ((($c = ((($d = $scope.Browser) == null ? $opal.cm('Browser') : $d))._scope).DOM == null ? $c.cm('DOM') : $c.DOM))._scope).NodeSet == null ? $a.cm('NodeSet') : $a.NodeSet).$new(document, roots)
        };
        } else {
        what = args.$shift();
        document = ((($a = args.$shift()) !== false && $a !== nil) ? $a : $gvars.document);
        if ((($a = self['$native?'](what)) !== nil && (!$a._isBoolean || $a == true))) {
          return (($a = ((($c = ((($d = $scope.Browser) == null ? $opal.cm('Browser') : $d))._scope).DOM == null ? $c.cm('DOM') : $c.DOM))._scope).Node == null ? $a.cm('Node') : $a.Node).$new(what)
        } else if ((($a = (($c = ((($d = ((($e = $scope.Browser) == null ? $opal.cm('Browser') : $e))._scope).DOM == null ? $d.cm('DOM') : $d.DOM))._scope).Node == null ? $c.cm('Node') : $c.Node)['$==='](what)) !== nil && (!$a._isBoolean || $a == true))) {
          return what
        } else if ((($a = (($c = $scope.String) == null ? $opal.cm('String') : $c)['$==='](what)) !== nil && (!$a._isBoolean || $a == true))) {
          
          var doc = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$try_convert(document).createElement('div');
          doc.innerHTML = what;

          return self.$DOM(doc.childNodes.length == 1 ? doc.childNodes[0] : doc);
        ;
          } else {
          return self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "argument not DOM convertible")
        };
      };
    };
        ;$opal.donate(self, ["$XML", "$DOM"]);
  })(self);
  (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Window(){};
      var self = $Window = $klass($base, $super, 'Window', $Window);

      var def = self._proto, $scope = self._scope, $a, $b, $c, TMP_2;

      def["native"] = nil;
      self.$include((($a = ((($b = ((($c = $scope.DOM) == null ? $opal.cm('DOM') : $c))._scope).Event == null ? $b.cm('Event') : $b.Event))._scope).Target == null ? $a.cm('Target') : $a.Target));

      ($a = ($b = self).$target, $a._p = (TMP_2 = function(value){var self = TMP_2._s || this, $a;
        if ($gvars.window == null) $gvars.window = nil;
if (value == null) value = nil;
      if ((($a = value == window) !== nil && (!$a._isBoolean || $a == true))) {
          return $gvars.window
          } else {
          return nil
        }}, TMP_2._s = self, TMP_2), $a).call($b);

      return (def.$document = function() {
        var self = this;

        return self.$DOM(self["native"].document);
      }, nil) && 'document';
    })(self, null)
    
  })(self);
  return $gvars.document = $gvars.window.$document();
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/dom.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $range = $opal.range;

  $opal.add_stubs(['$include', '$new', '$each', '$[]=', '$important', '$name', '$value', '$to_proc', '$to_s', '$enum_for', '$[]', '$alias_native', '$end_with?']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'CSS');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Declaration(){};
        var self = $Declaration = $klass($base, $super, 'Declaration', $Declaration);

        var def = self._proto, $scope = self._scope, $a, TMP_2, TMP_4;

        def["native"] = nil;
        self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

        self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

        def.$rule = function() {
          var $a, self = this;

          if ((($a = (typeof(self["native"].parentRule) !== "undefined")) !== nil && (!$a._isBoolean || $a == true))) {
            return (($a = $scope.Rule) == null ? $opal.cm('Rule') : $a).$new(self["native"].parentRule)
            } else {
            return nil
          };
        };

        def.$assign = function(data) {
          var $a, $b, TMP_1, self = this;

          ($a = ($b = data).$each, $a._p = (TMP_1 = function(name, value){var self = TMP_1._s || this;
if (name == null) name = nil;if (value == null) value = nil;
          return self['$[]='](name, value)}, TMP_1._s = self, TMP_1), $a).call($b);
          return self;
        };

        def.$replace = function(string) {
          var self = this;

          return self["native"].cssText = string;
        };

        def.$apply = TMP_2 = function() {
          var $a, $b, TMP_3, $c, $d, $e, $f, $g, self = this, $iter = TMP_2._p, block = $iter || nil;

          TMP_2._p = null;
          return ($a = ($b = ($c = ($d = (($e = ((($f = ((($g = $scope.Paggio) == null ? $opal.cm('Paggio') : $g))._scope).CSS == null ? $f.cm('CSS') : $f.CSS))._scope).Definition == null ? $e.cm('Definition') : $e.Definition)).$new, $c._p = block.$to_proc(), $c).call($d)).$each, $a._p = (TMP_3 = function(style){var self = TMP_3._s || this, $a;
            if (self["native"] == null) self["native"] = nil;
if (style == null) style = nil;
          if ((($a = style.$important()) !== nil && (!$a._isBoolean || $a == true))) {
              return self["native"].setProperty(style.$name(), style.$value(), "important");
              } else {
              return self["native"].setProperty(style.$name(), style.$value(), "");
            }}, TMP_3._s = self, TMP_3), $a).call($b);
        };

        def.$delete = function(name) {
          var self = this;

          return self["native"].removeProperty(name);
        };

        def['$[]'] = function(name) {
          var self = this;

          
      var result = self["native"].getPropertyValue(name);

      if (result == null || result === "") {
        return nil;
      }

      return result;
    ;
        };

        def['$[]='] = function(name, value) {
          var self = this;

          return self["native"].setProperty(name, value.$to_s(), "");
        };

        def['$important?'] = function(name) {
          var self = this;

          return self["native"].getPropertyPriority(name) == "important";
        };

        def.$each = TMP_4 = function() {
          var $a, self = this, $iter = TMP_4._p, block = $iter || nil;

          TMP_4._p = null;
          if ((block !== nil)) {
            } else {
            return self.$enum_for("each")
          };
          
      for (var i = 0, length = self["native"].length; i < length; i++) {
        var name  = self["native"].item(i);

        ((($a = $opal.$yieldX(block, [name, self['$[]'](name)])) === $breaker) ? $breaker.$v : $a)
      }
    ;
          return self;
        };

        self.$alias_native("length");

        self.$alias_native("to_s", "cssText");

        return (def.$method_missing = function(name, value) {
          var $a, self = this;

          if (value == null) {
            value = nil
          }
          if ((($a = name['$end_with?']("=")) !== nil && (!$a._isBoolean || $a == true))) {
            return self['$[]='](name['$[]']($range(0, -2, false)), value)
            } else {
            return self['$[]'](name)
          };
        }, nil) && 'method_missing';
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/css/declaration.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$is_a?', '$to_n', '$alias_native', '$new', '$DOM', '$===', '$join', '$map', '$insert', '$length', '$find', '$log', '$==', '$id', '$rules', '$__send__', '$to_proc']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'CSS');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $StyleSheet(){};
        var self = $StyleSheet = $klass($base, $super, 'StyleSheet', $StyleSheet);

        var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_5, $b;

        def["native"] = nil;
        self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

        def.$initialize = TMP_1 = function(what) {
          var $a, $b, $c, self = this, $iter = TMP_1._p, $yield = $iter || nil;

          TMP_1._p = null;
          if ((($a = what['$is_a?']((($b = ((($c = $scope.DOM) == null ? $opal.cm('DOM') : $c))._scope).Element == null ? $b.cm('Element') : $b.Element))) !== nil && (!$a._isBoolean || $a == true))) {
            return $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [what.$to_n().sheet])
            } else {
            return $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [what])
          };
        };

        self.$alias_native("disabled?", "disabled");

        self.$alias_native("href");

        self.$alias_native("title");

        self.$alias_native("type");

        def.$media = function() {
          var $a, self = this;

          if ((($a = self["native"].media != null) !== nil && (!$a._isBoolean || $a == true))) {
            return (($a = $scope.Media) == null ? $opal.cm('Media') : $a).$new(self["native"].media)
            } else {
            return nil
          };
        };

        def.$owner = function() {
          var self = this;

          return self.$DOM(self["native"].ownerNode);
        };

        def.$parent = function() {
          var $a, self = this;

          if ((($a = self["native"].parentStyleSheet != null) !== nil && (!$a._isBoolean || $a == true))) {
            return (($a = $scope.Sheet) == null ? $opal.cm('Sheet') : $a).$new(self["native"].parentStyleSheet)
            } else {
            return nil
          };
        };

        def.$rules = function() {
          var $a, $b, TMP_2, $c, $d, self = this;

          return ($a = ($b = (($c = ((($d = $scope.Native) == null ? $opal.cm('Native') : $d))._scope).Array == null ? $c.cm('Array') : $c.Array)).$new, $a._p = (TMP_2 = function(e){var self = TMP_2._s || this, $a;
if (e == null) e = nil;
          return (($a = $scope.Rule) == null ? $opal.cm('Rule') : $a).$new(e)}, TMP_2._s = self, TMP_2), $a).call($b, self["native"].cssRules);
        };

        def.$delete = function(index) {
          var self = this;

          return self["native"].deleteRule(index);
        };

        def.$insert = function(index, rule) {
          var self = this;

          return self["native"].insertRule(rule, index);
        };

        def.$rule = function(selector, body) {
          var $a, $b, TMP_3, self = this;

          if ((($a = (($b = $scope.String) == null ? $opal.cm('String') : $b)['$==='](selector)) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            selector = selector.$join(", ")
          };
          if ((($a = (($b = $scope.String) == null ? $opal.cm('String') : $b)['$==='](body)) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            body = ($a = ($b = body).$map, $a._p = (TMP_3 = function(name, value){var self = TMP_3._s || this;
if (name == null) name = nil;if (value == null) value = nil;
            return "" + (name) + ": " + (value) + ";"}, TMP_3._s = self, TMP_3), $a).call($b).$join("\n")
          };
          return self.$insert(self.$length(), "" + (selector) + " { " + (body) + " }");
        };

        def['$[]'] = function(id) {
          var $a, $b, TMP_4, self = this;

          return ($a = ($b = self.$rules()).$find, $a._p = (TMP_4 = function(r){var self = TMP_4._s || this;
if (r == null) r = nil;
          self.$log(r);
            return r.$id()['$=='](id);}, TMP_4._s = self, TMP_4), $a).call($b);
        };

        def.$method_missing = TMP_5 = function(args) {
          var $a, $b, self = this, $iter = TMP_5._p, block = $iter || nil;

          args = $slice.call(arguments, 0);
          TMP_5._p = null;
          return ($a = ($b = self.$rules()).$__send__, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
        };

        return (function($base, $super) {
          function $Media(){};
          var self = $Media = $klass($base, $super, 'Media', $Media);

          var def = self._proto, $scope = self._scope;

          def["native"] = nil;
          self.$alias_native("text", "mediaText");

          self.$alias_native("to_s", "mediaText");

          def.$push = function(medium) {
            var self = this;

            self["native"].appendMedium(medium);
            return self;
          };

          return (def.$delete = function(medium) {
            var self = this;

            return self["native"].deleteMedium(medium);
          }, nil) && 'delete';
        })(self, (($a = ((($b = $scope.Native) == null ? $opal.cm('Native') : $b))._scope).Array == null ? $a.cm('Array') : $a.Array));
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/css/style_sheet.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$==', '$[]', '$new', '$raise', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'CSS');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Rule(){};
        var self = $Rule = $klass($base, $super, 'Rule', $Rule);

        var def = self._proto, $scope = self._scope, $a, TMP_1;

        def["native"] = nil;
        self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

        $opal.cdecl($scope, 'STYLE_RULE', 1);

        $opal.cdecl($scope, 'CHARSET_RULE', 2);

        $opal.cdecl($scope, 'IMPORT_RULE', 3);

        $opal.cdecl($scope, 'MEDIA_RULE', 4);

        $opal.cdecl($scope, 'FONT_FACE_RULE', 5);

        $opal.cdecl($scope, 'PAGE_RULE', 6);

        $opal.cdecl($scope, 'KEYFRAMES_RULE', 7);

        $opal.cdecl($scope, 'KEYFRAME_RULE', 8);

        $opal.cdecl($scope, 'NAMESPACE_RULE', 10);

        $opal.cdecl($scope, 'COUNTER_STYLE_RULE', 11);

        $opal.cdecl($scope, 'SUPPORTS_RULE', 12);

        $opal.cdecl($scope, 'DOCUMENT_RULE', 13);

        $opal.cdecl($scope, 'FONT_FEATURE_VALUES_RULE', 14);

        $opal.cdecl($scope, 'VIEWPORT_RULE', 15);

        $opal.cdecl($scope, 'REGION_STYLE_RULE', 16);

        $opal.defs(self, '$new', TMP_1 = function(rule) {
          var $a, $b, self = this, $iter = TMP_1._p, $yield = $iter || nil, klass = nil;
          if (self.classes == null) self.classes = nil;

          TMP_1._p = null;
          if (self['$==']((($a = $scope.Rule) == null ? $opal.cm('Rule') : $a))) {
            ((($a = self.classes) !== false && $a !== nil) ? $a : self.classes = [nil, (($b = $scope.Style) == null ? $opal.cm('Style') : $b)]);
            if ((($a = klass = self.classes['$[]'](rule.type)) !== nil && (!$a._isBoolean || $a == true))) {
              return klass.$new(rule)
              } else {
              return self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "cannot instantiate a non derived Rule object")
            };
            } else {
            return $opal.find_super_dispatcher(self, 'new', TMP_1, null, $Rule).apply(self, [rule])
          };
        });

        self.$alias_native("text", "cssText");

        self.$alias_native("to_s", "cssText");

        def.$parent = function() {
          var $a, self = this;

          if ((($a = self["native"].parentRule != null) !== nil && (!$a._isBoolean || $a == true))) {
            return (($a = $scope.Rule) == null ? $opal.cm('Rule') : $a).$new(self["native"].parentRule)
            } else {
            return nil
          };
        };

        return (def.$style_sheet = function() {
          var $a, self = this;

          if ((($a = self["native"].parentStyleSheet != null) !== nil && (!$a._isBoolean || $a == true))) {
            return (($a = $scope.StyleSheet) == null ? $opal.cm('StyleSheet') : $a).$new(self["native"].parentStyleSheet)
            } else {
            return nil
          };
        }, nil) && 'style_sheet';
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/css/rule.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$alias_native', '$new', '$__send__', '$to_proc', '$declaration']);
  return (function($base) {
    var self = $module($base, 'Browser');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'CSS');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Rule(){};
        var self = $Rule = $klass($base, $super, 'Rule', $Rule);

        var def = self._proto, $scope = self._scope, $a;

        return (function($base, $super) {
          function $Style(){};
          var self = $Style = $klass($base, $super, 'Style', $Style);

          var def = self._proto, $scope = self._scope, TMP_1;

          def["native"] = nil;
          self.$alias_native("selector", "selectorText");

          self.$alias_native("id", "selectorText");

          def.$declaration = function() {
            var $a, self = this;

            return (($a = $scope.Declaration) == null ? $opal.cm('Declaration') : $a).$new(self["native"].style);
          };

          return (def.$method_missing = TMP_1 = function(args) {
            var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil;

            args = $slice.call(arguments, 0);
            TMP_1._p = null;
            return ($a = ($b = self.$declaration()).$__send__, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
          }, nil) && 'method_missing';
        })(self, (($a = $scope.Rule) == null ? $opal.cm('Rule') : $a))
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/css/rule/style.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $gvars = $opal.gvars;

  $opal.add_stubs(['$create_element', '$[]=', '$inner_text=', '$css', '$to_proc']);
  ;
  ;
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Kernel');

    var def = self._proto, $scope = self._scope, TMP_1;

    def.$CSS = TMP_1 = function(text) {
      var $a, $b, $c, self = this, $iter = TMP_1._p, block = $iter || nil, style = nil;
      if ($gvars.document == null) $gvars.document = nil;

      if (text == null) {
        text = nil
      }
      TMP_1._p = null;
      style = $gvars.document.$create_element("style");
      style['$[]=']("type", "text/css");
      if (block !== false && block !== nil) {
        style['$inner_text='](($a = ($b = (($c = $scope.Paggio) == null ? $opal.cm('Paggio') : $c)).$css, $a._p = block.$to_proc(), $a).call($b))
        } else {
        style['$inner_text='](text)
      };
      return style;
    }
        ;$opal.donate(self, ["$CSS"]);
  })(self);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser/css.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice;

  $opal.add_stubs([]);
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  return true;
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/browser.js.map
;
/* Generated by Opal 0.6.2 */
(function($opal) {
  var $a, $b, TMP_1, $c, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $gvars = $opal.gvars, prompt_for_name = nil, logo = nil;
  if ($gvars.$ == null) $gvars.$ = nil;

  $opal.add_stubs(['$new', '$prompt', '$==', '$alert', '$getElementById', '$[]', '$onclick=']);
  ;
  ;
  prompt_for_name = ($a = ($b = (($c = $scope.Proc) == null ? $opal.cm('Proc') : $c)).$new, $a._p = (TMP_1 = function(){var self = TMP_1._s || this, $a, $b, name = nil;
    if ($gvars.$ == null) $gvars.$ = nil;

  name = $gvars.$.$prompt("What's your name?");
    if ((($a = ((($b = name['$==']("")) !== false && $b !== nil) ? $b : name['$=='](nil))) !== nil && (!$a._isBoolean || $a == true))) {
      return $gvars.$.$alert("That's not a valid name.")
      } else {
      return $gvars.$.$alert("Hi, " + (name) + "!")
    };}, TMP_1._s = self, TMP_1), $a).call($b);
  logo = $gvars.$['$[]']("document").$getElementById("logo");
  return logo['$onclick='](prompt_for_name);
})(Opal);

//# sourceMappingURL=/__opal_source_maps__/main.js.map
;
