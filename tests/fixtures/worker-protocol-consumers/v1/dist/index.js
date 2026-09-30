// packages/worker-protocol/dist/version.js
var MIN_PROTOCOL_VERSION = 1;
var PROTOCOL_VERSION = 1;
function negotiateProtocolVersion(controlPlane, worker) {
  const highest = Math.min(controlPlane.max, worker.max);
  const lowest = Math.max(controlPlane.min, worker.min);
  return highest >= lowest ? highest : null;
}

// node_modules/.pnpm/zod@3.24.2/node_modules/zod/lib/index.mjs
var util;
(function(util2) {
  util2.assertEqual = (val) => val;
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
        fieldErrors[sub.path[0]].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var overrideErrorMap = errorMap;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === errorMap ? void 0 : errorMap
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
function __classPrivateFieldGet(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}
function __classPrivateFieldSet(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message === null || message === void 0 ? void 0 : message.message;
})(errorUtil || (errorUtil = {}));
var _ZodEnum_cache;
var _ZodNativeEnum_cache;
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (this._key instanceof Array) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    var _a, _b;
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message !== null && message !== void 0 ? message : ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: (_a = message !== null && message !== void 0 ? message : required_error) !== null && _a !== void 0 ? _a : ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: (_b = message !== null && message !== void 0 ? message : invalid_type_error) !== null && _b !== void 0 ? _b : ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    var _a;
    const ctx = {
      common: {
        issues: [],
        async: (_a = params === null || params === void 0 ? void 0 : params.async) !== null && _a !== void 0 ? _a : false,
        contextualErrorMap: params === null || params === void 0 ? void 0 : params.errorMap
      },
      path: (params === null || params === void 0 ? void 0 : params.path) || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    var _a, _b;
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if ((_b = (_a = err === null || err === void 0 ? void 0 : err.message) === null || _a === void 0 ? void 0 : _a.toLowerCase()) === null || _b === void 0 ? void 0 : _b.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params === null || params === void 0 ? void 0 : params.errorMap,
        async: true
      },
      path: (params === null || params === void 0 ? void 0 : params.path) || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let regex = `([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d`;
  if (args.precision) {
    regex = `${regex}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    regex = `${regex}(\\.\\d+)?`;
  }
  return regex;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if (!decoded.typ || !decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch (_a) {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch (_a) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    var _a, _b;
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof (options === null || options === void 0 ? void 0 : options.precision) === "undefined" ? null : options === null || options === void 0 ? void 0 : options.precision,
      offset: (_a = options === null || options === void 0 ? void 0 : options.offset) !== null && _a !== void 0 ? _a : false,
      local: (_b = options === null || options === void 0 ? void 0 : options.local) !== null && _b !== void 0 ? _b : false,
      ...errorUtil.errToObj(options === null || options === void 0 ? void 0 : options.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof (options === null || options === void 0 ? void 0 : options.precision) === "undefined" ? null : options === null || options === void 0 ? void 0 : options.precision,
      ...errorUtil.errToObj(options === null || options === void 0 ? void 0 : options.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options === null || options === void 0 ? void 0 : options.position,
      ...errorUtil.errToObj(options === null || options === void 0 ? void 0 : options.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  var _a;
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: (_a = params === null || params === void 0 ? void 0 : params.coerce) !== null && _a !== void 0 ? _a : false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / Math.pow(10, decCount);
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null, min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: (params === null || params === void 0 ? void 0 : params.coerce) || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch (_a) {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  var _a;
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: (_a = params === null || params === void 0 ? void 0 : params.coerce) !== null && _a !== void 0 ? _a : false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: (params === null || params === void 0 ? void 0 : params.coerce) || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: (params === null || params === void 0 ? void 0 : params.coerce) || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    return this._cached = { shape, keys };
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") ;
      else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          var _a, _b, _c, _d;
          const defaultError = (_c = (_b = (_a = this._def).errorMap) === null || _b === void 0 ? void 0 : _b.call(_a, issue, ctx).message) !== null && _c !== void 0 ? _c : ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: (_d = errorUtil.errToObj(message).message) !== null && _d !== void 0 ? _d : defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    util.objectKeys(mask).forEach((key) => {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    });
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    util.objectKeys(this.shape).forEach((key) => {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    });
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    util.objectKeys(this.shape).forEach((key) => {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    });
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    util.objectKeys(this.shape).forEach((key) => {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    });
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [
          ctx.common.contextualErrorMap,
          ctx.schemaErrorMap,
          getErrorMap(),
          errorMap
        ].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [
          ctx.common.contextualErrorMap,
          ctx.schemaErrorMap,
          getErrorMap(),
          errorMap
        ].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  constructor() {
    super(...arguments);
    _ZodEnum_cache.set(this, void 0);
  }
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!__classPrivateFieldGet(this, _ZodEnum_cache, "f")) {
      __classPrivateFieldSet(this, _ZodEnum_cache, new Set(this._def.values), "f");
    }
    if (!__classPrivateFieldGet(this, _ZodEnum_cache, "f").has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
_ZodEnum_cache = /* @__PURE__ */ new WeakMap();
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  constructor() {
    super(...arguments);
    _ZodNativeEnum_cache.set(this, void 0);
  }
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!__classPrivateFieldGet(this, _ZodNativeEnum_cache, "f")) {
      __classPrivateFieldSet(this, _ZodNativeEnum_cache, new Set(util.getValidEnumValues(this._def.values)), "f");
    }
    if (!__classPrivateFieldGet(this, _ZodNativeEnum_cache, "f").has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
_ZodNativeEnum_cache = /* @__PURE__ */ new WeakMap();
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return base;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return base;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({ status: status.value, value: result }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = /* @__PURE__ */ Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      var _a, _b;
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          var _a2, _b2;
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = (_b2 = (_a2 = params.fatal) !== null && _a2 !== void 0 ? _a2 : fatal) !== null && _b2 !== void 0 ? _b2 : true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = (_b = (_a = params.fatal) !== null && _a !== void 0 ? _a : fatal) !== null && _b !== void 0 ? _b : true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;
var z = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  defaultErrorMap: errorMap,
  setErrorMap,
  getErrorMap,
  makeIssue,
  EMPTY_PATH,
  addIssueToContext,
  ParseStatus,
  INVALID,
  DIRTY,
  OK,
  isAborted,
  isDirty,
  isValid,
  isAsync,
  get util() {
    return util;
  },
  get objectUtil() {
    return objectUtil;
  },
  ZodParsedType,
  getParsedType,
  ZodType,
  datetimeRegex,
  ZodString,
  ZodNumber,
  ZodBigInt,
  ZodBoolean,
  ZodDate,
  ZodSymbol,
  ZodUndefined,
  ZodNull,
  ZodAny,
  ZodUnknown,
  ZodNever,
  ZodVoid,
  ZodArray,
  ZodObject,
  ZodUnion,
  ZodDiscriminatedUnion,
  ZodIntersection,
  ZodTuple,
  ZodRecord,
  ZodMap,
  ZodSet,
  ZodFunction,
  ZodLazy,
  ZodLiteral,
  ZodEnum,
  ZodNativeEnum,
  ZodPromise,
  ZodEffects,
  ZodTransformer: ZodEffects,
  ZodOptional,
  ZodNullable,
  ZodDefault,
  ZodCatch,
  ZodNaN,
  BRAND,
  ZodBranded,
  ZodPipeline,
  ZodReadonly,
  custom,
  Schema: ZodType,
  ZodSchema: ZodType,
  late,
  get ZodFirstPartyTypeKind() {
    return ZodFirstPartyTypeKind;
  },
  coerce,
  any: anyType,
  array: arrayType,
  bigint: bigIntType,
  boolean: booleanType,
  date: dateType,
  discriminatedUnion: discriminatedUnionType,
  effect: effectsType,
  "enum": enumType,
  "function": functionType,
  "instanceof": instanceOfType,
  intersection: intersectionType,
  lazy: lazyType,
  literal: literalType,
  map: mapType,
  nan: nanType,
  nativeEnum: nativeEnumType,
  never: neverType,
  "null": nullType,
  nullable: nullableType,
  number: numberType,
  object: objectType,
  oboolean,
  onumber,
  optional: optionalType,
  ostring,
  pipeline: pipelineType,
  preprocess: preprocessType,
  promise: promiseType,
  record: recordType,
  set: setType,
  strictObject: strictObjectType,
  string: stringType,
  symbol: symbolType,
  transformer: effectsType,
  tuple: tupleType,
  "undefined": undefinedType,
  union: unionType,
  unknown: unknownType,
  "void": voidType,
  NEVER,
  ZodIssueCode,
  quotelessJson,
  ZodError
});

// packages/worker-protocol/dist/ids.js
var uuidSchema = z.string().uuid();
var opaquePrincipalTextSchema = z.string().min(1).superRefine((value, ctx) => {
  if (value !== value.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "principal ID must not contain leading or trailing whitespace"
    });
  }
  if (new TextEncoder().encode(value).byteLength > 200) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "principal ID exceeds 200 UTF-8 bytes"
    });
  }
});
var organizationIdSchema = uuidSchema.brand();
var companyIdSchema = uuidSchema.brand();
var agentIdSchema = uuidSchema.brand();
var runIdSchema = uuidSchema.brand();
var issueIdSchema = uuidSchema.brand();
var internalAgentRunIdSchema = uuidSchema.brand();
var conversationIdSchema = uuidSchema.brand();
var crewRunIdSchema = uuidSchema.brand();
var oneShotOperationIdSchema = uuidSchema.brand();
var browserRequestIdSchema = uuidSchema.brand();
var reconciliationIdSchema = uuidSchema.brand();
var jobIdSchema = uuidSchema.brand();
var workerIdSchema = uuidSchema.brand();
var targetIdSchema = uuidSchema.brand();
var leaseIdSchema = uuidSchema.brand();
var eventIdSchema = uuidSchema.brand();
var artifactIdSchema = uuidSchema.brand();
var secretHandleIdSchema = uuidSchema.brand();
var serviceIdSchema = uuidSchema.brand();
var serviceInstanceIdSchema = uuidSchema.brand();
var principalIdSchema = opaquePrincipalTextSchema.brand();
var sandboxIdSchema = z.string().min(1).max(200).brand();
var attemptNumberSchema = z.number().int().positive().max(1e6);
var eventSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
var fenceTokenSchema = z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/).brand();
var sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/).brand();

// packages/worker-protocol/dist/states.js
function canTransition(transitions, from, to) {
  return (transitions[from] ?? []).includes(to);
}
var WORKLOAD_TYPES = ["batch", "browser_session", "service"];
var workloadTypeSchema = z.enum(WORKLOAD_TYPES);
var JOB_STATUSES = [
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "dead_letter"
];
var jobStatusSchema = z.enum(JOB_STATUSES);
var JOB_TRANSITION_REASONS = [
  "normal",
  "cancel",
  "non_retryable_failure",
  "policy_exhausted"
];
var jobTransitionReasonSchema = z.enum(JOB_TRANSITION_REASONS);
var JOB_TRANSITIONS = {
  queued: ["running", "cancel_requested", "cancelled"],
  running: ["cancel_requested", "succeeded", "failed", "dead_letter"],
  cancel_requested: ["cancelled", "failed", "dead_letter"],
  succeeded: [],
  failed: [],
  cancelled: [],
  dead_letter: []
};
var JOB_TERMINAL_REASON_GUARDS = {
  dead_letter: "policy_exhausted",
  failed: "non_retryable_failure"
};
function canTransitionJobStatus(from, to, { reason }) {
  const targets = JOB_TRANSITIONS[from] ?? [];
  if (!targets.includes(to))
    return false;
  const guard = JOB_TERMINAL_REASON_GUARDS[to];
  if (guard !== void 0)
    return reason === guard;
  return true;
}
var ATTEMPT_STATUSES = [
  "pending",
  "offered",
  "leased",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "expired"
];
var attemptStatusSchema = z.enum(ATTEMPT_STATUSES);
var ATTEMPT_TRANSITIONS = {
  pending: ["offered", "cancelled", "expired"],
  offered: ["leased", "expired", "cancelled"],
  leased: ["running", "cancel_requested", "expired", "cancelled"],
  running: ["cancel_requested", "succeeded", "failed", "expired"],
  cancel_requested: ["cancelled", "succeeded", "failed", "expired"],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: []
};
function canTransitionAttemptStatus(from, to) {
  return canTransition(ATTEMPT_TRANSITIONS, from, to);
}
var LEASE_STATUSES = ["offered", "active", "released", "expired", "revoked"];
var leaseStatusSchema = z.enum(LEASE_STATUSES);
var LEASE_TRANSITIONS = {
  offered: ["active", "expired", "revoked"],
  active: ["released", "expired", "revoked"],
  released: [],
  expired: [],
  revoked: []
};
function canTransitionLeaseStatus(from, to) {
  return canTransition(LEASE_TRANSITIONS, from, to);
}
var BROWSER_SESSION_STATUSES = [
  "queued",
  "leased",
  "starting",
  "active",
  "waiting_approval",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "expired"
];
var browserSessionStatusSchema = z.enum(BROWSER_SESSION_STATUSES);
var BROWSER_SESSION_TRANSITIONS = {
  queued: ["leased", "cancelled", "expired"],
  leased: ["starting", "cancel_requested", "cancelled", "expired"],
  starting: ["active", "cancel_requested", "failed", "cancelled", "expired"],
  active: ["waiting_approval", "cancel_requested", "succeeded", "failed", "cancelled", "expired"],
  waiting_approval: ["active", "cancel_requested", "failed", "cancelled", "expired"],
  cancel_requested: ["cancelled", "succeeded", "failed", "expired"],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: []
};
function canTransitionBrowserSessionStatus(from, to) {
  return canTransition(BROWSER_SESSION_TRANSITIONS, from, to);
}
var SERVICE_DESIRED_STATES = ["running", "paused", "stopped", "deleted"];
var serviceDesiredStateSchema = z.enum(SERVICE_DESIRED_STATES);
var SERVICE_DESIRED_TRANSITIONS = {
  running: ["paused", "stopped", "deleted"],
  paused: ["running", "stopped", "deleted"],
  stopped: ["running", "deleted"],
  deleted: []
};
function canTransitionServiceDesiredState(from, to) {
  return canTransition(SERVICE_DESIRED_TRANSITIONS, from, to);
}
var SERVICE_INSTANCE_STATUSES = [
  "pending",
  "leased",
  "starting",
  "healthy",
  "unhealthy",
  "stopping",
  "stopped",
  "failed",
  "lost"
];
var serviceInstanceStatusSchema = z.enum(SERVICE_INSTANCE_STATUSES);
var SERVICE_INSTANCE_TRANSITIONS = {
  pending: ["leased", "failed", "lost"],
  leased: ["starting", "stopping", "failed", "lost"],
  starting: ["healthy", "unhealthy", "stopping", "failed", "lost"],
  healthy: ["unhealthy", "stopping", "failed", "lost"],
  unhealthy: ["healthy", "stopping", "failed", "lost"],
  stopping: ["stopped", "failed", "lost"],
  stopped: [],
  failed: [],
  lost: []
};
function canTransitionServiceInstanceStatus(from, to) {
  return canTransition(SERVICE_INSTANCE_TRANSITIONS, from, to);
}

// packages/worker-protocol/dist/wire-safety.js
var FORBIDDEN_WIRE_KEYS = /* @__PURE__ */ new Set([
  "env",
  "environment",
  "apikey",
  "password",
  "token",
  "accesstoken",
  "refreshtoken",
  "cookie",
  "authorization",
  "credential",
  "credentials",
  "secretvalue"
]);
function normalizeWireKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function collectForbiddenKeyPaths(value, prefix, out) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectForbiddenKeyPaths(value[index], [...prefix, index], out);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value).sort()) {
      const path = [...prefix, key];
      if (FORBIDDEN_WIRE_KEYS.has(normalizeWireKey(key)))
        out.push(path);
      collectForbiddenKeyPaths(value[key], path, out);
    }
  }
}
function findForbiddenWireKeys(value) {
  const paths = [];
  collectForbiddenKeyPaths(value, [], paths);
  return paths.map((segments) => segments.join("."));
}
function addForbiddenWireKeyIssues(value, ctx) {
  const paths = [];
  collectForbiddenKeyPaths(value, [], paths);
  for (const segments of paths) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: segments,
      message: `forbidden credential-bearing key at ${segments.join(".")}`
    });
  }
}
var registeredSecretCanaries = /* @__PURE__ */ new Set();
function registerSecretCanaries(canaries) {
  for (const canary of canaries) {
    if (typeof canary === "string" && canary.length > 0)
      registeredSecretCanaries.add(canary);
  }
}
function clearRegisteredSecretCanaries() {
  registeredSecretCanaries.clear();
}
function getRegisteredSecretCanaries() {
  return new Set(registeredSecretCanaries);
}
function visitWireStrings(value, visit) {
  const walk = (node, path) => {
    if (typeof node === "string") {
      visit(node, path);
      return;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        walk(node[index], path === "" ? String(index) : `${path}.${index}`);
      }
      return;
    }
    if (isPlainObject(node)) {
      for (const key of Object.keys(node).sort()) {
        walk(node[key], path === "" ? key : `${path}.${key}`);
      }
    }
  };
  walk(value, "");
}
function findSecretCanaryStringMatches(value, canaries) {
  const needles = canaries ? [...canaries].filter((c) => typeof c === "string" && c.length > 0) : [...registeredSecretCanaries];
  if (needles.length === 0)
    return [];
  const hits = [];
  visitWireStrings(value, (stringValue, path) => {
    if (needles.some((needle) => stringValue.includes(needle)))
      hits.push(path);
  });
  return hits.sort();
}
function createSeededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = state + 1831565813 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var CORPUS_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomToken(rng, minLen, maxLen) {
  const length = minLen + Math.floor(rng() * (maxLen - minLen + 1));
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CORPUS_ALPHABET[Math.floor(rng() * CORPUS_ALPHABET.length)];
  }
  return out;
}
function setAtDottedPath(root, path, next) {
  const segments = path.split(".");
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    cursor = cursor[segments[i]];
  }
  cursor[segments[segments.length - 1]] = next;
}
function generateWireStringSample(rng, embedCanary) {
  const argCount = 1 + Math.floor(rng() * 4);
  const urlCount = 1 + Math.floor(rng() * 3);
  const sample = {
    workload: {
      command: randomToken(rng, 3, 10),
      args: Array.from({ length: argCount }, () => `--${randomToken(rng, 2, 8)}=${randomToken(rng, 2, 12)}`)
    },
    urls: Array.from({ length: urlCount }, () => `https://${randomToken(rng, 3, 8)}.example.com/${randomToken(rng, 2, 10)}`),
    headers: { "x-a": randomToken(rng, 3, 12), "x-b": randomToken(rng, 3, 12) },
    nested: [[randomToken(rng, 3, 6), randomToken(rng, 3, 6)], { deep: randomToken(rng, 3, 10) }],
    extensions: [
      { namespace: "com.armyofagents.corpus", value: { note: randomToken(rng, 3, 12), list: [randomToken(rng, 2, 6), randomToken(rng, 2, 6)] } }
    ]
  };
  if (embedCanary === void 0)
    return { sample, canaryPath: null };
  const leafPaths = [];
  visitWireStrings(sample, (_value, path) => {
    leafPaths.push(path);
  });
  const chosen = leafPaths[Math.floor(rng() * leafPaths.length)];
  setAtDottedPath(sample, chosen, `pre-${embedCanary}-post`);
  return { sample, canaryPath: chosen };
}

// packages/worker-protocol/dist/source.js
var PRINCIPAL_TYPES = ["user", "agent", "service", "system"];
var principalTypeSchema = z.enum(PRINCIPAL_TYPES);
var principalV1Schema = z.object({
  principalType: principalTypeSchema,
  principalId: principalIdSchema
}).strict();
var ONE_SHOT_OPERATION_KINDS = ["extraction", "compaction", "readiness_probe"];
var oneShotOperationKindSchema = z.enum(ONE_SHOT_OPERATION_KINDS);
var EXECUTION_SOURCE_KINDS = [
  "task_run",
  "commander_turn",
  "crew_run",
  "one_shot",
  "browser_request",
  "service_reconcile"
];
var taskRunSourceSchema = z.object({
  kind: z.literal("task_run"),
  runId: runIdSchema,
  issueId: issueIdSchema,
  requestedBy: principalV1Schema,
  executionPrincipal: principalV1Schema,
  assigneeAgentId: agentIdSchema
}).strict();
var commanderTurnSourceSchema = z.object({
  kind: z.literal("commander_turn"),
  internalAgentRunId: internalAgentRunIdSchema,
  conversationId: conversationIdSchema,
  requestedBy: principalV1Schema,
  executionPrincipal: principalV1Schema
}).strict();
var crewRunSourceSchema = z.object({
  kind: z.literal("crew_run"),
  crewRunId: crewRunIdSchema,
  requestedBy: principalV1Schema,
  executionPrincipal: principalV1Schema
}).strict();
var oneShotSourceSchema = z.object({
  kind: z.literal("one_shot"),
  operationId: oneShotOperationIdSchema,
  operationKind: oneShotOperationKindSchema,
  requestedBy: principalV1Schema,
  executionPrincipal: principalV1Schema
}).strict();
var browserRequestSourceSchema = z.object({
  kind: z.literal("browser_request"),
  browserRequestId: browserRequestIdSchema,
  parentJobId: jobIdSchema.nullable(),
  requestedBy: principalV1Schema,
  executionPrincipal: principalV1Schema
}).strict();
var serviceReconcileSourceSchema = z.object({
  kind: z.literal("service_reconcile"),
  serviceId: serviceIdSchema,
  generation: z.number().int().positive(),
  reconciliationId: reconciliationIdSchema,
  requestedBy: principalV1Schema,
  executionPrincipal: principalV1Schema
}).strict();
var executionSourceV1Schema = z.discriminatedUnion("kind", [
  taskRunSourceSchema,
  commanderTurnSourceSchema,
  crewRunSourceSchema,
  oneShotSourceSchema,
  browserRequestSourceSchema,
  serviceReconcileSourceSchema
]).superRefine((source, ctx) => {
  if (source.kind === "task_run") {
    if (source.executionPrincipal.principalType !== "agent") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionPrincipal", "principalType"],
        message: "task_run execution principal must be an agent"
      });
    }
    if (String(source.executionPrincipal.principalId) !== String(source.assigneeAgentId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assigneeAgentId"],
        message: "task_run assignee agent must equal the execution principal ID"
      });
    }
  }
});

// packages/worker-protocol/dist/canonical-json.js
var CanonicalJsonError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "CanonicalJsonError";
  }
};
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalizeString(str) {
  let out = '"';
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code >= 55296 && code <= 56319) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next < 56320 || next > 57343) {
        throw new CanonicalJsonError("lone high surrogate in string");
      }
      out += str[i] + str[i + 1];
      i += 1;
      continue;
    }
    if (code >= 56320 && code <= 57343) {
      throw new CanonicalJsonError("lone low surrogate in string");
    }
    if (code === 34)
      out += '\\"';
    else if (code === 92)
      out += "\\\\";
    else if (code === 8)
      out += "\\b";
    else if (code === 9)
      out += "\\t";
    else if (code === 10)
      out += "\\n";
    else if (code === 12)
      out += "\\f";
    else if (code === 13)
      out += "\\r";
    else if (code < 32)
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    else
      out += str[i];
  }
  return `${out}"`;
}
function canonicalizeNumber(num) {
  if (!Number.isFinite(num)) {
    throw new CanonicalJsonError("non-finite number is not allowed");
  }
  if (!Number.isInteger(num)) {
    throw new CanonicalJsonError("float is not allowed in the v1 subset");
  }
  if (!Number.isSafeInteger(num)) {
    throw new CanonicalJsonError("unsafe integer is not allowed");
  }
  if (Object.is(num, -0))
    return "0";
  return String(num);
}
function canonicalizeJsonV1(value) {
  if (value === null)
    return "null";
  const t = typeof value;
  if (t === "boolean")
    return value ? "true" : "false";
  if (t === "number")
    return canonicalizeNumber(value);
  if (t === "string")
    return canonicalizeString(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJsonV1(item)).join(",")}]`;
  }
  if (t === "object") {
    const obj = value;
    const keys = Object.keys(obj).sort();
    const members = keys.map((key) => `${canonicalizeString(key)}:${canonicalizeJsonV1(obj[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new CanonicalJsonError(`unsupported value of type ${t}`);
}
function canonicalEventDigestInputV1(event) {
  if (!isPlainObject2(event)) {
    throw new CanonicalJsonError("event must be a plain object");
  }
  const rest = {};
  for (const key of Object.keys(event)) {
    if (key === "eventDigest")
      continue;
    rest[key] = event[key];
  }
  return new TextEncoder().encode(canonicalizeJsonV1(rest));
}
async function verifyWorkerEventDigestV1(event, sha256Fn) {
  if (!isPlainObject2(event))
    return false;
  const supplied = event.eventDigest;
  if (typeof supplied !== "string")
    return false;
  let input;
  try {
    input = canonicalEventDigestInputV1(event);
  } catch {
    return false;
  }
  const recomputed = await sha256Fn(input);
  return typeof recomputed === "string" && recomputed === supplied;
}

// packages/worker-protocol/dist/extensions.js
var encoder = new TextEncoder();
var utf8ByteLength = (value) => encoder.encode(value).length;
function isPlainObject3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var KNOWN_CRITICAL_EXTENSION_NAMESPACES = /* @__PURE__ */ new Set();
var WIRE_EXTENSION_LIMITS = {
  maxCount: 16,
  namespaceMaxBytes: 100,
  valueMaxContainerDepth: 8,
  valueMaxArrayItems: 128,
  valueMaxObjectKeys: 64,
  valueMaxKeyBytes: 100,
  valueMaxCanonicalBytes: 16384,
  combinedMaxCanonicalBytes: 65536
};
var namespaceLabel = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
var namespaceName = "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?";
var namespaceRegex = new RegExp(`^${namespaceLabel}(?:\\.${namespaceLabel})+(?:/${namespaceName})?$`);
var wireExtensionSchema = z.object({
  namespace: z.string().regex(namespaceRegex, "namespace must be lowercase reverse-DNS with an optional /name").refine((value) => utf8ByteLength(value) <= WIRE_EXTENSION_LIMITS.namespaceMaxBytes, {
    message: `namespace exceeds ${WIRE_EXTENSION_LIMITS.namespaceMaxBytes} UTF-8 bytes`
  }),
  schemaVersion: z.number().int().min(1).max(1e6),
  critical: z.boolean(),
  value: z.unknown()
}).strict();
var wireExtensionsArraySchema = z.array(wireExtensionSchema);
function canonicalByteLength(value) {
  return utf8ByteLength(canonicalizeJsonV1(value));
}
function addExtensionValueStructureIssues(value, ctx, base) {
  const walk = (node, containerDepth, path) => {
    if (node === null || typeof node === "boolean" || typeof node === "string")
      return;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "extension value numbers must be finite" });
      }
      return;
    }
    if (Array.isArray(node)) {
      const level = containerDepth + 1;
      if (level > WIRE_EXTENSION_LIMITS.valueMaxContainerDepth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `extension value exceeds ${WIRE_EXTENSION_LIMITS.valueMaxContainerDepth} container levels` });
        return;
      }
      if (node.length > WIRE_EXTENSION_LIMITS.valueMaxArrayItems) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `extension value array exceeds ${WIRE_EXTENSION_LIMITS.valueMaxArrayItems} items` });
      }
      node.forEach((item, index) => walk(item, level, [...path, index]));
      return;
    }
    if (isPlainObject3(node)) {
      const level = containerDepth + 1;
      if (level > WIRE_EXTENSION_LIMITS.valueMaxContainerDepth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `extension value exceeds ${WIRE_EXTENSION_LIMITS.valueMaxContainerDepth} container levels` });
        return;
      }
      const keys = Object.keys(node);
      if (keys.length > WIRE_EXTENSION_LIMITS.valueMaxObjectKeys) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `extension value object exceeds ${WIRE_EXTENSION_LIMITS.valueMaxObjectKeys} keys` });
      }
      for (const key of keys) {
        if (utf8ByteLength(key) > WIRE_EXTENSION_LIMITS.valueMaxKeyBytes) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, key], message: `extension value key exceeds ${WIRE_EXTENSION_LIMITS.valueMaxKeyBytes} UTF-8 bytes` });
        }
        walk(node[key], level, [...path, key]);
      }
      return;
    }
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "extension value must be JSON (string/number/boolean/null/array/object)" });
  };
  walk(value, 0, base);
}
function addWireExtensionArrayIssues(extensions, ctx, base) {
  if (extensions.length > WIRE_EXTENSION_LIMITS.maxCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: base, message: `at most ${WIRE_EXTENSION_LIMITS.maxCount} extensions are permitted` });
  }
  const seenNamespaces = /* @__PURE__ */ new Set();
  let combinedBytes = 0;
  extensions.forEach((extension, index) => {
    const path = [...base, index];
    if (seenNamespaces.has(extension.namespace)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "namespace"], message: "duplicate extension namespace" });
    }
    seenNamespaces.add(extension.namespace);
    if (extension.critical === true && !KNOWN_CRITICAL_EXTENSION_NAMESPACES.has(extension.namespace)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "critical"], message: "unknown critical extension fails closed" });
    }
    if (extension.value === void 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "value"], message: "extension value is required" });
      return;
    }
    addExtensionValueStructureIssues(extension.value, ctx, [...path, "value"]);
    try {
      const bytes = canonicalByteLength(extension.value);
      combinedBytes += bytes;
      if (bytes > WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "value"], message: `extension value exceeds ${WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes} canonical UTF-8 bytes` });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "value"], message: "extension value is not canonicalizable" });
    }
  });
  if (combinedBytes > WIRE_EXTENSION_LIMITS.combinedMaxCanonicalBytes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: base, message: `combined extension value budget exceeds ${WIRE_EXTENSION_LIMITS.combinedMaxCanonicalBytes} canonical UTF-8 bytes` });
  }
}

// packages/worker-protocol/dist/policy.js
var policyIdSchema = z.string().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
var resourceLimitsSchema = z.object({
  cpuMillis: z.number().int().min(100).max(128e3),
  memoryMiB: z.number().int().min(128).max(1048576),
  pids: z.number().int().min(16).max(1e5),
  diskMiB: z.number().int().min(128).max(10485760)
}).strict();
var IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
var DNS_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
function isLowercaseDnsHost(host) {
  if (host.length < 1 || host.length > 253)
    return false;
  if (host.includes(":"))
    return false;
  if (IPV4_LITERAL.test(host))
    return false;
  return DNS_HOST.test(host);
}
var networkAllowRuleSchema = z.object({
  scheme: z.literal("https"),
  host: z.string().superRefine((value, ctx) => {
    if (!isLowercaseDnsHost(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must be a lowercase DNS name with no IP literal" });
    }
  }),
  port: z.number().int().min(1).max(65535)
}).strict().superRefine((rule, ctx) => addForbiddenWireKeyIssues(rule, ctx));
var networkPolicyV1Schema = z.object({
  policyId: policyIdSchema,
  version: z.number().int().positive(),
  digest: sha256DigestSchema,
  defaultAction: z.literal("deny"),
  allow: z.array(networkAllowRuleSchema).max(256),
  denyPrivateNetworks: z.literal(true),
  denyMetadata: z.literal(true),
  denyControlPlane: z.literal(true)
}).strict().superRefine((policy, ctx) => addForbiddenWireKeyIssues(policy, ctx));
var networkPolicyRefSchema = z.object({ policyId: policyIdSchema, version: z.number().int().positive(), digest: sha256DigestSchema }).strict().superRefine((ref, ctx) => addForbiddenWireKeyIssues(ref, ctx));
var SECRET_MATERIALIZATION_KINDS = ["proxy", "env", "file"];
var envTargetSchema = z.string().min(1).max(256).regex(/^[A-Z_][A-Z0-9_]*$/);
var SANDBOX_SECRET_ROOT = "/run/aoa-secrets/";
function isSandboxSecretFilePath(target) {
  if (target.length < SANDBOX_SECRET_ROOT.length + 1 || target.length > 1024)
    return false;
  if (!target.startsWith(SANDBOX_SECRET_ROOT))
    return false;
  if (target.includes("\\"))
    return false;
  for (let i = 0; i < target.length; i += 1) {
    const c = target.charCodeAt(i);
    if (c < 32 || c === 127)
      return false;
  }
  const segments = target.slice(1).split("/");
  for (const seg of segments) {
    if (seg.length === 0)
      return false;
    if (seg === "." || seg === "..")
      return false;
  }
  return true;
}
var fileTargetSchema = z.string().superRefine((value, ctx) => {
  if (!isSandboxSecretFilePath(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `file target must be an absolute path under ${SANDBOX_SECRET_ROOT} with no ..` });
  }
});
var secretMaterializationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("proxy") }).strict(),
  z.object({ kind: z.literal("env"), target: envTargetSchema }).strict(),
  z.object({ kind: z.literal("file"), target: fileTargetSchema }).strict()
]);
var SECRET_USE_POLICIES = ["fence_proxy", "remote_server_fenced", "sandbox_local_only"];
var secretUsePolicySchema = z.enum(SECRET_USE_POLICIES);
var secretHandleRefSchema = z.object({
  handleId: secretHandleIdSchema,
  materialization: secretMaterializationSchema,
  usePolicy: secretUsePolicySchema
}).strict().superRefine((ref, ctx) => {
  addForbiddenWireKeyIssues(ref, ctx);
  const kind = ref.materialization.kind;
  if (kind === "proxy" && ref.usePolicy !== "fence_proxy") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["usePolicy"],
      message: "proxy materialization is the per-request fence proxy and requires usePolicy 'fence_proxy'"
    });
  }
  if ((kind === "env" || kind === "file") && ref.usePolicy === "fence_proxy") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["usePolicy"],
      message: "env/file materialization cannot claim the per-request fence proxy policy"
    });
  }
});
var ARTIFACT_RETENTION_CLASSES = ["ephemeral", "run", "audit", "checkpoint"];
var artifactRetentionClassSchema = z.enum(ARTIFACT_RETENTION_CLASSES);
var OFFLINE_POLICIES = ["cancel", "finish_without_remote_effects", "continue_until_lease_expiry"];
var offlinePolicySchema = z.enum(OFFLINE_POLICIES);

// packages/worker-protocol/dist/job.js
var timestampV1Schema = z.string().datetime({ offset: true });
var slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
var capabilitySchema = z.string().max(100).regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/);
var TARGET_CLASSES = ["managed_cloud", "organization_dedicated", "owner_desktop"];
var targetClassSchema = z.enum(TARGET_CLASSES);
var TARGET_SCOPES = ["platform", "organization", "owner"];
var targetScopeSchema = z.enum(TARGET_SCOPES);
var TRUST_CLASSES = ["shared_isolated", "organization_isolated", "owner_local_trusted"];
var trustClassSchema = z.enum(TRUST_CLASSES);
var CREDENTIAL_KINDS = ["none", "platform_brokered", "organization_brokered", "owner_bound"];
var credentialKindSchema = z.enum(CREDENTIAL_KINDS);
var DATA_LOCALITIES = ["transfer_allowed", "organization_target_only", "owner_device_only"];
var dataLocalitySchema = z.enum(DATA_LOCALITIES);
var FALLBACK_MODES = ["forbidden", "ordered_explicit"];
var fallbackModeSchema = z.enum(FALLBACK_MODES);
var PLACEMENT_MATRIX = {
  managed_cloud: {
    targetScope: "platform",
    trustClass: "shared_isolated",
    credentials: ["none", "platform_brokered"],
    localities: ["transfer_allowed"]
  },
  organization_dedicated: {
    targetScope: "organization",
    trustClass: "organization_isolated",
    credentials: ["none", "platform_brokered", "organization_brokered"],
    localities: ["transfer_allowed", "organization_target_only"]
  },
  owner_desktop: {
    targetScope: "owner",
    trustClass: "owner_local_trusted",
    credentials: ["none", "platform_brokered", "owner_bound"],
    localities: ["transfer_allowed", "owner_device_only"]
  }
};
function isTargetPlacementAllowed(targetClass, trustClass, credentialKind, dataLocality) {
  const row = PLACEMENT_MATRIX[targetClass];
  return row.trustClass === trustClass && row.credentials.includes(credentialKind) && row.localities.includes(dataLocality);
}
function addDuplicateIssues(values, ctx, path, label) {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `duplicate ${label}` });
  }
}
var providerConstraintRefV1Schema = z.object({ profileId: slugSchema, version: z.number().int().positive(), digest: sha256DigestSchema }).strict();
var targetRequirementsV1Schema = z.object({
  allowedTargetClasses: z.array(targetClassSchema).min(1),
  allowedTrustClasses: z.array(trustClassSchema).min(1),
  requiredOwnerPrincipalId: principalIdSchema.nullable(),
  credentialKind: credentialKindSchema,
  dataLocality: dataLocalitySchema,
  fallback: z.object({ mode: fallbackModeSchema, orderedTargetClasses: z.array(targetClassSchema) }).strict(),
  providerConstraints: providerConstraintRefV1Schema
}).strict();
var placementV1Schema = z.object({
  policyId: slugSchema,
  version: z.number().int().positive(),
  digest: sha256DigestSchema,
  targetRequirements: targetRequirementsV1Schema
}).strict();
function addPlacementIssues(placement, ctx, base) {
  const requirements = placement.targetRequirements;
  const reqPath = [...base, "targetRequirements"];
  const { allowedTargetClasses, allowedTrustClasses, credentialKind, dataLocality, fallback } = requirements;
  addDuplicateIssues(allowedTargetClasses, ctx, [...reqPath, "allowedTargetClasses"], "target class");
  addDuplicateIssues(allowedTrustClasses, ctx, [...reqPath, "allowedTrustClasses"], "trust class");
  addDuplicateIssues(fallback.orderedTargetClasses, ctx, [...reqPath, "fallback", "orderedTargetClasses"], "fallback target class");
  for (const targetClass of allowedTargetClasses) {
    const row = PLACEMENT_MATRIX[targetClass];
    if (!allowedTrustClasses.includes(row.trustClass)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "allowedTrustClasses"], message: `${targetClass} requires trust class ${row.trustClass}` });
    }
    if (!row.credentials.includes(credentialKind)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "credentialKind"], message: `credential ${credentialKind} is not permitted for ${targetClass}` });
    }
    if (!row.localities.includes(dataLocality)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "dataLocality"], message: `locality ${dataLocality} is not permitted for ${targetClass}` });
    }
  }
  const requiredTrust = new Set(allowedTargetClasses.map((targetClass) => PLACEMENT_MATRIX[targetClass].trustClass));
  for (const trustClass of allowedTrustClasses) {
    if (!requiredTrust.has(trustClass)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "allowedTrustClasses"], message: `trust class ${trustClass} is not required by any allowed target class` });
    }
  }
  if (credentialKind === "owner_bound" || dataLocality === "owner_device_only") {
    if (requirements.requiredOwnerPrincipalId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "requiredOwnerPrincipalId"], message: "owner-bound placement requires a non-null owner" });
    }
    const onlyOwnerDesktop = allowedTargetClasses.length === 1 && allowedTargetClasses[0] === "owner_desktop";
    if (!onlyOwnerDesktop) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "allowedTargetClasses"], message: "owner-bound placement may target only owner_desktop" });
    }
  }
  if (credentialKind === "organization_brokered" || dataLocality === "organization_target_only") {
    const onlyOrg = allowedTargetClasses.length === 1 && allowedTargetClasses[0] === "organization_dedicated";
    if (!onlyOrg) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "allowedTargetClasses"], message: "organization-brokered placement may target only organization_dedicated" });
    }
  }
  if (fallback.mode === "forbidden") {
    if (fallback.orderedTargetClasses.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "fallback", "orderedTargetClasses"], message: "forbidden fallback must have an empty order" });
    }
  } else {
    if (credentialKind !== "none" && credentialKind !== "platform_brokered") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "fallback"], message: "ordered fallback is allowed only for none or platform_brokered credentials" });
    }
    if (dataLocality !== "transfer_allowed") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "fallback"], message: "ordered fallback requires transfer_allowed locality" });
    }
    fallback.orderedTargetClasses.forEach((targetClass, index) => {
      if (!allowedTargetClasses.includes(targetClass)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "fallback", "orderedTargetClasses", index], message: "ordered fallback class is outside the allowed set" });
      } else if (!isTargetPlacementAllowed(targetClass, PLACEMENT_MATRIX[targetClass].trustClass, credentialKind, dataLocality) || !allowedTrustClasses.includes(PLACEMENT_MATRIX[targetClass].trustClass)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "fallback", "orderedTargetClasses", index], message: "ordered fallback class does not satisfy its matrix row" });
      }
    });
  }
}
var adapterRefV1Schema = z.object({
  type: z.string().min(1).max(100),
  version: z.string().min(1).max(100),
  configArtifactId: artifactIdSchema.nullable()
}).strict();
var workspaceBaseV1Schema = z.object({
  kind: z.enum(["git_commit", "content_manifest"]),
  algorithm: z.enum(["git_sha1", "git_sha256", "sha256"]),
  revision: z.string()
}).strict().superRefine((base, ctx) => {
  const expected = base.algorithm === "git_sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (!expected.test(base.revision)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["revision"], message: `revision must match ${base.algorithm}` });
  }
});
var workspaceV1Schema = z.object({
  manifestArtifactId: artifactIdSchema,
  base: workspaceBaseV1Schema,
  manifestHash: sha256DigestSchema,
  mode: z.enum(["read_only", "read_write"])
}).strict();
var batchWorkloadV1Schema = z.object({
  command: z.string().min(1).max(256),
  args: z.array(z.string().max(8192)).max(256),
  stdinArtifactId: artifactIdSchema.nullable(),
  maxRuntimeSeconds: z.number().int().min(1).max(86400)
}).strict();
var browserWorkloadV1Schema = z.object({
  engine: z.literal("chromium"),
  viewport: z.object({ width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384) }).strict(),
  locale: z.string().min(1).max(100),
  timezone: z.string().min(1).max(100),
  recordTrace: z.boolean(),
  recordVideo: z.boolean(),
  maxSessionSeconds: z.number().int().min(1).max(43200)
}).strict();
var serviceWorkloadV1Schema = z.object({
  serviceId: serviceIdSchema,
  serviceInstanceId: serviceInstanceIdSchema,
  generation: z.number().int().positive(),
  command: z.string().min(1).max(256),
  args: z.array(z.string().max(8192)).max(256),
  checkpointArtifactId: artifactIdSchema.nullable(),
  gracefulStopSeconds: z.number().int().min(1).max(300)
}).strict();
var jobEnvelopeBaseSchema = z.object({
  protocolVersion: z.literal(1),
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  organizationId: organizationIdSchema,
  companyId: companyIdSchema,
  source: executionSourceV1Schema,
  createdAt: timestampV1Schema,
  notBefore: timestampV1Schema.nullable(),
  deadline: timestampV1Schema,
  inputHash: sha256DigestSchema,
  policyHash: sha256DigestSchema,
  placement: placementV1Schema,
  adapter: adapterRefV1Schema,
  requiredCapabilities: z.array(capabilitySchema).max(128),
  workspace: workspaceV1Schema.nullable(),
  secretHandles: secretHandleRefSchema.array().max(64),
  resourceLimits: resourceLimitsSchema,
  networkPolicy: networkPolicyRefSchema,
  offlinePolicy: offlinePolicySchema,
  extensions: wireExtensionsArraySchema
});
var batchJobEnvelopeSchema = jobEnvelopeBaseSchema.extend({ workloadType: z.literal("batch"), workload: batchWorkloadV1Schema }).strict();
var browserJobEnvelopeSchema = jobEnvelopeBaseSchema.extend({ workloadType: z.literal("browser_session"), workload: browserWorkloadV1Schema }).strict();
var serviceJobEnvelopeSchema = jobEnvelopeBaseSchema.extend({ workloadType: z.literal("service"), workload: serviceWorkloadV1Schema }).strict();
var jobEnvelopeV1Schema = z.discriminatedUnion("workloadType", [batchJobEnvelopeSchema, browserJobEnvelopeSchema, serviceJobEnvelopeSchema]).superRefine((job, ctx) => {
  addForbiddenWireKeyIssues(job, ctx);
  addWireExtensionArrayIssues(job.extensions, ctx, ["extensions"]);
  const created = Date.parse(job.createdAt);
  const deadline = Date.parse(job.deadline);
  if (!(deadline > created)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deadline"], message: "deadline must be strictly after createdAt" });
  }
  if (job.notBefore !== null) {
    const notBefore = Date.parse(job.notBefore);
    if (notBefore > deadline) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notBefore"], message: "notBefore must not be after deadline" });
    }
  }
  addDuplicateIssues(job.requiredCapabilities, ctx, ["requiredCapabilities"], "required capability");
  addDuplicateIssues(job.secretHandles.map((handle) => String(handle.handleId)), ctx, ["secretHandles"], "secret handle ID");
  addPlacementIssues(job.placement, ctx, ["placement"]);
});
var optionalExtensions = wireExtensionsArraySchema.optional();
function refineLeaseSafety(message, ctx) {
  addForbiddenWireKeyIssues(message, ctx);
  if (message.extensions)
    addWireExtensionArrayIssues(message.extensions, ctx, ["extensions"]);
}
var leaseOfferV1Schema = z.object({
  protocolVersion: z.literal(1),
  workerId: workerIdSchema,
  leaseId: leaseIdSchema,
  fenceToken: fenceTokenSchema,
  ackDeadline: timestampV1Schema,
  expiresAt: timestampV1Schema,
  job: jobEnvelopeV1Schema,
  extensions: optionalExtensions
}).strict().superRefine((offer, ctx) => {
  refineLeaseSafety(offer, ctx);
  if (!(Date.parse(offer.ackDeadline) < Date.parse(offer.expiresAt))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ackDeadline"], message: "ackDeadline must be before expiresAt" });
  }
});
var leaseAckV1Schema = z.object({
  protocolVersion: z.literal(1),
  workerId: workerIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  leaseId: leaseIdSchema,
  fenceToken: fenceTokenSchema,
  ackedAt: timestampV1Schema,
  extensions: optionalExtensions
}).strict().superRefine(refineLeaseSafety);
var leaseRenewRequestV1Schema = z.object({
  protocolVersion: z.literal(1),
  workerId: workerIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  leaseId: leaseIdSchema,
  fenceToken: fenceTokenSchema,
  observedAt: timestampV1Schema,
  extensions: optionalExtensions
}).strict().superRefine(refineLeaseSafety);
var leaseRenewResponseV1Schema = z.object({
  protocolVersion: z.literal(1),
  workerId: workerIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  leaseId: leaseIdSchema,
  fenceToken: fenceTokenSchema,
  expiresAt: timestampV1Schema,
  cancelRequested: z.boolean(),
  cancelReason: z.string().max(1e3).nullable(),
  extensions: optionalExtensions
}).strict().superRefine(refineLeaseSafety);

// packages/worker-protocol/dist/artifacts.js
function isSafeWorkspacePath(path) {
  if (typeof path !== "string")
    return false;
  if (path.length === 0 || path.length > 4096)
    return false;
  if (path.startsWith("/"))
    return false;
  if (path.includes("\\"))
    return false;
  if (path.includes(":"))
    return false;
  for (let i = 0; i < path.length; i += 1) {
    const c = path.charCodeAt(i);
    if (c < 32 || c === 127)
      return false;
  }
  for (const seg of path.split("/")) {
    if (seg.length === 0)
      return false;
    if (seg === "." || seg === "..")
      return false;
    if (seg.length > 255)
      return false;
  }
  return true;
}
var workspacePathSchema = z.string().superRefine((value, ctx) => {
  if (!isSafeWorkspacePath(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unsafe workspace path" });
  }
});
function expectedAttemptObjectPrefix(input) {
  return `organizations/${input.organizationId}/jobs/${input.jobId}/attempts/${input.attempt}/`;
}
function expectedQuarantineObjectPrefix(input) {
  return `quarantine/organizations/${input.organizationId}/jobs/${input.jobId}/attempts/${input.attempt}/`;
}
function objectKeyHasPrefix(key, prefix) {
  return isSafeWorkspacePath(key) && key.startsWith(prefix) && key.length > prefix.length;
}
var ignorePolicySchema = z.object({ kind: z.enum(["gitignore_plus_aoa", "explicit"]), digest: sha256DigestSchema }).strict();
var inclusionSchema = z.object({ tracked: z.literal(true), untracked: z.enum(["include", "exclude"]), ignored: z.literal(false) }).strict();
var workspaceBaseV1Schema2 = z.object({
  kind: z.enum(["git_commit", "content_manifest"]),
  algorithm: z.enum(["git_sha1", "git_sha256", "sha256"]),
  revision: z.string(),
  dirty: z.boolean(),
  caseMode: z.enum(["sensitive", "insensitive_preserving"]),
  ignorePolicy: ignorePolicySchema,
  inclusion: inclusionSchema
}).strict().superRefine((base, ctx) => {
  const expected = base.algorithm === "git_sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (!expected.test(base.revision)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["revision"], message: `revision must match ${base.algorithm}` });
  }
});
var WORKSPACE_ENTRY_KINDS = ["file", "directory"];
var workspaceEntryKindSchema = z.enum(WORKSPACE_ENTRY_KINDS);
var WORKSPACE_PROVENANCE = ["tracked", "untracked", "generated"];
var workspaceProvenanceSchema = z.enum(WORKSPACE_PROVENANCE);
var nonNegativeIntSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
var workspaceEntrySchema = z.object({
  path: workspacePathSchema,
  kind: workspaceEntryKindSchema,
  provenance: workspaceProvenanceSchema,
  sizeBytes: nonNegativeIntSchema,
  sha256: sha256DigestSchema.nullable(),
  executable: z.boolean()
}).strict().superRefine((entry, ctx) => {
  if (entry.kind === "file" && entry.sha256 === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sha256"], message: "file entries require a content hash" });
  }
  if (entry.kind === "directory") {
    if (entry.sha256 !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sha256"], message: "directory entries have no content hash" });
    }
    if (entry.sizeBytes !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sizeBytes"], message: "directory entries have zero size" });
    }
    if (entry.executable !== false) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["executable"], message: "directory entries are not executable" });
    }
  }
});
var snapshotProvenanceSchema = z.object({
  capturedAt: timestampV1Schema,
  sourceTargetId: targetIdSchema,
  folderGrantId: z.string().uuid().nullable(),
  captureToolVersion: z.string().min(1).max(200)
}).strict();
function addPathCollisionIssues(paths, ctx, base) {
  const seen = /* @__PURE__ */ new Set();
  const seenLower = /* @__PURE__ */ new Set();
  paths.forEach((path, index) => {
    if (seen.has(path)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...base, index, "path"], message: "duplicate workspace path" });
    }
    const lower = path.toLowerCase();
    if (!seen.has(path) && seenLower.has(lower)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...base, index, "path"], message: "case-colliding workspace path" });
    }
    seen.add(path);
    seenLower.add(lower);
  });
}
var workspaceManifestV1Schema = z.object({
  protocolVersion: z.literal(1),
  organizationId: organizationIdSchema,
  companyId: companyIdSchema,
  artifactId: artifactIdSchema,
  base: workspaceBaseV1Schema2,
  snapshotProvenance: snapshotProvenanceSchema,
  entries: z.array(workspaceEntrySchema).max(1e6)
}).strict().superRefine((manifest, ctx) => {
  addForbiddenWireKeyIssues(manifest, ctx);
  addPathCollisionIssues(manifest.entries.map((entry) => entry.path), ctx, ["entries"]);
});
var PATCH_OPERATION_KINDS = ["create", "modify", "delete", "rename"];
var mutatingOpFields = { path: workspacePathSchema, resultSha256: sha256DigestSchema, sizeBytes: nonNegativeIntSchema };
var patchOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), ...mutatingOpFields }).strict(),
  z.object({ op: z.literal("modify"), ...mutatingOpFields }).strict(),
  z.object({ op: z.literal("delete"), path: workspacePathSchema }).strict(),
  z.object({ op: z.literal("rename"), fromPath: workspacePathSchema, ...mutatingOpFields }).strict()
]);
var workspacePatchManifestV1Schema = z.object({
  protocolVersion: z.literal(1),
  organizationId: organizationIdSchema,
  companyId: companyIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  artifactId: artifactIdSchema,
  base: workspaceBaseV1Schema2,
  baseManifestHash: sha256DigestSchema,
  resultManifestHash: sha256DigestSchema,
  operations: z.array(patchOperationSchema).min(1).max(1e6)
}).strict().superRefine((patch, ctx) => {
  addForbiddenWireKeyIssues(patch, ctx);
  if (patch.baseManifestHash === patch.resultManifestHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resultManifestHash"], message: "a patch must change the manifest hash" });
  }
  const paths = patch.operations.map((op) => op.path);
  if (new Set(paths).size !== paths.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["operations"], message: "duplicate operation path" });
  }
});
var ARTIFACT_KINDS = [
  "workspace_snapshot",
  "workspace_patch",
  "log",
  "screenshot",
  "dom_snapshot",
  "browser_cookie_state",
  "browser_storage_state",
  "playwright_trace",
  "browser_video",
  "download",
  "service_checkpoint",
  "other"
];
var artifactKindSchema = z.enum(ARTIFACT_KINDS);
var RESTRICTED_ARTIFACT_KINDS = ARTIFACT_KINDS;
var artifactSensitivitySchema = z.literal("restricted");
var contentTypeSchema = z.string().min(3).max(255).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i);
var artifactManifestV1Schema = z.object({
  protocolVersion: z.literal(1),
  organizationId: organizationIdSchema,
  companyId: companyIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  artifactId: artifactIdSchema,
  kind: artifactKindSchema,
  sensitivity: artifactSensitivitySchema,
  retention: artifactRetentionClassSchema,
  objectKey: z.string().min(1).max(1024),
  sizeBytes: nonNegativeIntSchema,
  sha256: sha256DigestSchema,
  contentType: contentTypeSchema,
  createdAt: timestampV1Schema
}).strict().superRefine((manifest, ctx) => {
  addForbiddenWireKeyIssues(manifest, ctx);
  const prefix = expectedAttemptObjectPrefix(manifest);
  if (!objectKeyHasPrefix(manifest.objectKey, prefix)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["objectKey"],
      message: "objectKey must be a safe key under organizations/<org>/jobs/<job>/attempts/<attempt>/"
    });
  }
});
var httpsUrlSchema = z.string().min(9).max(8192).regex(/^https:\/\/\S+$/, "url must be https");
var FORBIDDEN_HEADER_NORMALIZED = /* @__PURE__ */ new Set([
  ...FORBIDDEN_WIRE_KEYS,
  "xapikey",
  "xamzsecuritytoken",
  "xamzcredential",
  "proxyauthorization",
  "wwwauthenticate",
  "setcookie",
  "authentication"
]);
var grantHeadersSchema = z.record(z.string().min(1).max(128).regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "invalid header name"), z.string().max(8192));
function addGrantHeaderIssues(headers, ctx) {
  const keys = Object.keys(headers);
  if (keys.length > 32) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headers"], message: "at most 32 headers" });
  }
  for (const key of keys) {
    if (FORBIDDEN_HEADER_NORMALIZED.has(normalizeWireKey(key))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headers", key], message: "credential-bearing header is forbidden on a grant" });
    }
  }
}
var artifactTransferGrantRequestV1Schema = z.object({
  protocolVersion: z.literal(1),
  operation: z.enum(["upload", "download"]),
  workerId: workerIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  leaseId: leaseIdSchema,
  fenceToken: fenceTokenSchema,
  artifactId: artifactIdSchema,
  expectedObjectKey: z.string().min(1).max(1024),
  expectedSha256: sha256DigestSchema,
  maxBytes: nonNegativeIntSchema
}).strict().superRefine((request, ctx) => {
  addForbiddenWireKeyIssues(request, ctx);
  const key = request.expectedObjectKey;
  const bindsJobAttempt = isSafeWorkspacePath(key) && key.startsWith("organizations/") && key.includes(`/jobs/${request.jobId}/attempts/${request.attempt}/`);
  if (!bindsJobAttempt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedObjectKey"],
      message: "expectedObjectKey must be a safe key binding this job and attempt"
    });
  }
});
function addOrdinaryGrantIssues(grant, ctx) {
  addForbiddenWireKeyIssues(grant, ctx);
  addGrantHeaderIssues(grant.headers, ctx);
  if (!(Date.parse(grant.expiresAt) > Date.parse(grant.issuedAt))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiresAt must be after issuedAt" });
  }
  if (!(isSafeWorkspacePath(grant.objectKey) && grant.objectKey.startsWith("organizations/"))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objectKey"], message: "objectKey must be a safe ordinary attempt object key" });
  }
}
var artifactUploadGrantV1Schema = z.object({
  protocolVersion: z.literal(1),
  operation: z.literal("upload"),
  artifactId: artifactIdSchema,
  method: z.literal("PUT"),
  url: httpsUrlSchema,
  headers: grantHeadersSchema,
  issuedAt: timestampV1Schema,
  expiresAt: timestampV1Schema,
  maxBytes: nonNegativeIntSchema,
  expectedSha256: sha256DigestSchema,
  objectKey: z.string().min(1).max(1024),
  redaction: z.literal("secret")
}).strict().superRefine((grant, ctx) => addOrdinaryGrantIssues(grant, ctx));
var artifactDownloadGrantV1Schema = z.object({
  protocolVersion: z.literal(1),
  operation: z.literal("download"),
  artifactId: artifactIdSchema,
  method: z.literal("GET"),
  url: httpsUrlSchema,
  headers: grantHeadersSchema,
  issuedAt: timestampV1Schema,
  expiresAt: timestampV1Schema,
  maxBytes: nonNegativeIntSchema,
  expectedSha256: sha256DigestSchema,
  objectKey: z.string().min(1).max(1024),
  redaction: z.literal("secret")
}).strict().superRefine((grant, ctx) => addOrdinaryGrantIssues(grant, ctx));
var artifactCommitPayloadV1Schema = z.object({
  protocolVersion: z.literal(1),
  workerId: workerIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  leaseId: leaseIdSchema,
  fenceToken: fenceTokenSchema,
  manifest: artifactManifestV1Schema
}).strict().superRefine((commit, ctx) => {
  addForbiddenWireKeyIssues(commit, ctx);
  if (String(commit.jobId) !== String(commit.manifest.jobId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "jobId"], message: "commit jobId must match the manifest" });
  }
  if (commit.attempt !== commit.manifest.attempt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "attempt"], message: "commit attempt must match the manifest" });
  }
});
var QUARANTINE_REASONS = [
  "stale_fence",
  "late_output",
  "hash_mismatch",
  "wrong_prefix",
  "size_mismatch",
  "unknown_artifact",
  "corrupt_checkpoint"
];
var quarantineReasonSchema = z.enum(QUARANTINE_REASONS);
var deviceGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
var quarantineGrantPayloadV1Schema = z.object({
  protocolVersion: z.literal(1),
  workerId: workerIdSchema,
  targetId: targetIdSchema,
  deviceGeneration: deviceGenerationSchema,
  organizationId: organizationIdSchema,
  companyId: companyIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  observedLeaseId: leaseIdSchema,
  observedFenceToken: fenceTokenSchema,
  reason: quarantineReasonSchema,
  artifactId: artifactIdSchema,
  expectedObjectKey: z.string().min(1).max(1024),
  expectedSha256: sha256DigestSchema,
  sizeBytes: nonNegativeIntSchema
}).strict().superRefine((grant, ctx) => {
  addForbiddenWireKeyIssues(grant, ctx);
  if (!objectKeyHasPrefix(grant.expectedObjectKey, expectedQuarantineObjectPrefix(grant))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedObjectKey"],
      message: "expectedObjectKey must be under the distinct quarantine prefix for this org/job/attempt"
    });
  }
});
var QUARANTINE_MAX_TTL_MS = 5 * 60 * 1e3;
var quarantineUploadGrantV1Schema = z.object({
  protocolVersion: z.literal(1),
  operation: z.literal("quarantine_upload"),
  artifactId: artifactIdSchema,
  method: z.literal("PUT"),
  url: httpsUrlSchema,
  headers: grantHeadersSchema,
  issuedAt: timestampV1Schema,
  expiresAt: timestampV1Schema,
  maxBytes: nonNegativeIntSchema,
  expectedSha256: sha256DigestSchema,
  quarantineObjectKey: z.string().min(1).max(1024),
  redaction: z.literal("secret")
}).strict().superRefine((grant, ctx) => {
  addForbiddenWireKeyIssues(grant, ctx);
  addGrantHeaderIssues(grant.headers, ctx);
  const issued = Date.parse(grant.issuedAt);
  const expires = Date.parse(grant.expiresAt);
  if (!(expires > issued)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiresAt must be after issuedAt" });
  } else if (expires - issued > QUARANTINE_MAX_TTL_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "quarantine upload grant expiry must be at most five minutes" });
  }
  if (!(isSafeWorkspacePath(grant.quarantineObjectKey) && grant.quarantineObjectKey.startsWith("quarantine/"))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["quarantineObjectKey"], message: "quarantineObjectKey must be a safe key under the quarantine prefix" });
  }
});
var quarantineFinalizePayloadV1Schema = z.object({
  protocolVersion: z.literal(1),
  workerId: workerIdSchema,
  targetId: targetIdSchema,
  deviceGeneration: deviceGenerationSchema,
  organizationId: organizationIdSchema,
  companyId: companyIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  observedLeaseId: leaseIdSchema,
  observedFenceToken: fenceTokenSchema,
  reason: quarantineReasonSchema,
  artifactId: artifactIdSchema,
  quarantineObjectKey: z.string().min(1).max(1024),
  expectedSha256: sha256DigestSchema,
  sizeBytes: nonNegativeIntSchema,
  manifest: artifactManifestV1Schema
}).strict().superRefine((finalize, ctx) => {
  addForbiddenWireKeyIssues(finalize, ctx);
  if (!objectKeyHasPrefix(finalize.quarantineObjectKey, expectedQuarantineObjectPrefix(finalize))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["quarantineObjectKey"],
      message: "quarantineObjectKey must be under the distinct quarantine prefix for this org/job/attempt"
    });
  }
  const m = finalize.manifest;
  if (String(m.organizationId) !== String(finalize.organizationId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "organizationId"], message: "manifest organization must match" });
  }
  if (String(m.jobId) !== String(finalize.jobId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "jobId"], message: "manifest jobId must match" });
  }
  if (m.attempt !== finalize.attempt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "attempt"], message: "manifest attempt must match" });
  }
  if (String(m.artifactId) !== String(finalize.artifactId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "artifactId"], message: "manifest artifactId must match" });
  }
  if (String(m.sha256) !== String(finalize.expectedSha256)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "sha256"], message: "manifest sha256 must match the observed hash" });
  }
  if (m.sizeBytes !== finalize.sizeBytes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "sizeBytes"], message: "manifest sizeBytes must match the observed size" });
  }
});
var quarantineUploadReceiptV1Schema = z.object({
  protocolVersion: z.literal(1),
  receiptId: z.string().uuid(),
  quarantineObjectKey: z.string().min(1).max(1024),
  observed: z.object({
    workerId: workerIdSchema,
    targetId: targetIdSchema,
    deviceGeneration: deviceGenerationSchema,
    jobId: jobIdSchema,
    attempt: attemptNumberSchema,
    leaseId: leaseIdSchema,
    fenceToken: fenceTokenSchema
  }).strict(),
  artifact: z.object({
    artifactId: artifactIdSchema,
    sha256: sha256DigestSchema,
    sizeBytes: nonNegativeIntSchema,
    sensitivity: artifactSensitivitySchema,
    provenance: workspaceProvenanceSchema
  }).strict(),
  reason: quarantineReasonSchema,
  receivedAt: timestampV1Schema,
  disposition: z.literal("quarantined")
}).strict().superRefine((receipt, ctx) => {
  addForbiddenWireKeyIssues(receipt, ctx);
  const key = receipt.quarantineObjectKey;
  const bindsJobAttempt = isSafeWorkspacePath(key) && key.startsWith("quarantine/organizations/") && key.includes(`/jobs/${receipt.observed.jobId}/attempts/${receipt.observed.attempt}/`);
  if (!bindsJobAttempt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["quarantineObjectKey"],
      message: "quarantineObjectKey must be a safe key under the quarantine prefix binding the observed job/attempt"
    });
  }
});

// packages/worker-protocol/dist/events.js
var nonNegativeIntSchema2 = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
var positiveGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
function boundedUtf8(maxBytes) {
  return z.string().min(1).superRefine((value, ctx) => {
    if (new TextEncoder().encode(value).byteLength > maxBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `exceeds ${maxBytes} UTF-8 bytes` });
    }
  });
}
var attemptStartedPayloadV1Schema = z.object({ sandboxId: sandboxIdSchema }).strict();
var LOG_STREAMS = ["stdout", "stderr", "system"];
var LOG_LEVELS = ["debug", "info", "warn", "error"];
var logPayloadV1Schema = z.object({
  stream: z.enum(LOG_STREAMS),
  level: z.enum(LOG_LEVELS),
  message: z.string().max(65536)
}).strict();
var progressPayloadV1Schema = z.object({
  message: z.string().max(2e3),
  percent: z.number().int().min(0).max(100).nullable()
}).strict();
var usagePayloadV1Schema = z.object({
  inputTokens: nonNegativeIntSchema2,
  outputTokens: nonNegativeIntSchema2,
  cachedInputTokens: nonNegativeIntSchema2,
  runtimeMillis: nonNegativeIntSchema2
}).strict();
var artifactPreparedPayloadV1Schema = z.object({ artifactId: artifactIdSchema, kind: z.string().min(1).max(100) }).strict();
var browserObservationPayloadV1Schema = z.object({
  artifactIds: z.array(artifactIdSchema).max(128),
  url: z.string().max(4096).nullable(),
  title: z.string().max(1e3).nullable()
}).strict();
var browserApprovalRequestedPayloadV1Schema = z.object({
  approvalId: z.string().uuid(),
  action: z.string().min(1).max(200),
  summary: z.string().max(4e3)
}).strict();
var WORK_QUESTION_VALUE_MAX_BYTES = 16384;
var WORK_QUESTION_VALUE_MAX_DEPTH = 8;
function addBoundedJsonDepthIssues(value, ctx, path, maxDepth) {
  const walk = (node, depth, nodePath) => {
    if (Array.isArray(node)) {
      if (depth + 1 > maxDepth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: nodePath, message: `value exceeds ${maxDepth} container levels` });
        return;
      }
      node.forEach((item, index) => walk(item, depth + 1, [...nodePath, index]));
      return;
    }
    if (node !== null && typeof node === "object") {
      if (depth + 1 > maxDepth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: nodePath, message: `value exceeds ${maxDepth} container levels` });
        return;
      }
      for (const key of Object.keys(node)) {
        walk(node[key], depth + 1, [...nodePath, key]);
      }
    }
  };
  walk(value, 0, path);
}
var boundedJsonValueSchema = z.unknown().superRefine((value, ctx) => {
  addBoundedJsonDepthIssues(value, ctx, [], WORK_QUESTION_VALUE_MAX_DEPTH);
  try {
    const bytes = new TextEncoder().encode(canonicalizeJsonV1(value)).byteLength;
    if (bytes > WORK_QUESTION_VALUE_MAX_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `value exceeds ${WORK_QUESTION_VALUE_MAX_BYTES} canonical UTF-8 bytes` });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value is not canonicalizable" });
  }
});
var runtimeDecisionCommonShape = {
  requestId: z.string().uuid(),
  nonce: boundedUtf8(200),
  requestDigest: sha256DigestSchema,
  schemaVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourceRevision: nonNegativeIntSchema2,
  expiresAt: timestampV1Schema,
  title: z.string().max(500),
  summary: z.string().max(4e3).nullable()
};
var PERMISSION_TIMEOUT_POLICIES = ["deny", "cancel_run", "park_run", "continue_with_default", "escalate"];
var permissionTimeoutPolicySchema = z.enum(PERMISSION_TIMEOUT_POLICIES);
var PERMISSION_DEFAULT_DECISIONS = ["allow_once", "allow_run", "deny"];
var permissionDefaultDecisionSchema = z.enum(PERMISSION_DEFAULT_DECISIONS);
var permissionRuntimeDecisionRequestV1Schema = z.object({
  decisionKind: z.literal("permission"),
  ...runtimeDecisionCommonShape,
  timeoutPolicy: permissionTimeoutPolicySchema,
  defaultDecision: permissionDefaultDecisionSchema.nullable(),
  toolName: z.string().max(200).nullable(),
  command: z.string().max(4096).nullable(),
  cwd: z.string().max(4096).nullable(),
  path: z.string().max(4096).nullable(),
  networkTarget: z.string().max(1e3).nullable(),
  riskClass: z.string().max(100).nullable()
}).strict();
var WORK_QUESTION_TIMEOUT_POLICIES = ["cancel_run", "park_run", "continue_with_default", "escalate"];
var workQuestionTimeoutPolicySchema = z.enum(WORK_QUESTION_TIMEOUT_POLICIES);
var workQuestionOptionV1Schema = z.object({
  optionId: boundedUtf8(200),
  label: boundedUtf8(1e3),
  value: boundedJsonValueSchema,
  isDefault: z.boolean()
}).strict();
var workQuestionRuntimeDecisionRequestV1Schema = z.object({
  decisionKind: z.literal("work_question"),
  ...runtimeDecisionCommonShape,
  timeoutPolicy: workQuestionTimeoutPolicySchema,
  promptText: z.string().max(8e3),
  options: z.array(workQuestionOptionV1Schema).max(32)
}).strict();
var runtimeDecisionRequestV1Schema = z.discriminatedUnion("decisionKind", [
  permissionRuntimeDecisionRequestV1Schema,
  workQuestionRuntimeDecisionRequestV1Schema
]).superRefine((request, ctx) => {
  if (request.decisionKind === "permission") {
    if (request.timeoutPolicy === "continue_with_default") {
      if (request.defaultDecision === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultDecision"], message: "continue_with_default requires a non-null defaultDecision" });
      }
    } else if (request.defaultDecision !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultDecision"], message: "defaultDecision must be null unless timeoutPolicy is continue_with_default" });
    }
    return;
  }
  const defaults = request.options.filter((option) => option.isDefault === true).length;
  if (request.timeoutPolicy === "continue_with_default") {
    if (defaults !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "continue_with_default requires exactly one isDefault option" });
    }
  } else if (defaults !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "options may not carry a default unless timeoutPolicy is continue_with_default" });
  }
});
var serviceInstanceRefShape = {
  serviceId: serviceIdSchema,
  serviceInstanceId: serviceInstanceIdSchema,
  generation: positiveGenerationSchema
};
var serviceInstanceStartedPayloadV1Schema = z.object({ ...serviceInstanceRefShape, providerResourceId: z.string().min(1).max(200) }).strict();
var SERVICE_HEALTH_STATUSES = ["healthy", "unhealthy"];
var serviceHealthPayloadV1Schema = z.object({ ...serviceInstanceRefShape, status: z.enum(SERVICE_HEALTH_STATUSES), detail: z.string().max(4e3).nullable() }).strict();
var serviceCheckpointPreparedPayloadV1Schema = z.object({ artifactId: artifactIdSchema, ...serviceInstanceRefShape }).strict();
var serviceCheckpointRestoredPayloadV1Schema = z.object({ artifactId: artifactIdSchema, ...serviceInstanceRefShape }).strict();
var serviceGracefulStopObservedPayloadV1Schema = z.object({ ...serviceInstanceRefShape, deadline: timestampV1Schema }).strict();
var serviceInstanceStoppedPayloadV1Schema = z.object({ ...serviceInstanceRefShape, exitCode: z.number().int().nullable() }).strict();
var serviceInstanceLostPayloadV1Schema = z.object({ ...serviceInstanceRefShape, reason: z.string().min(1).max(1e3) }).strict();
var serviceProviderInterruptedPayloadV1Schema = z.object({ ...serviceInstanceRefShape, reason: z.string().min(1).max(1e3) }).strict();
var serviceProviderResumedPayloadV1Schema = z.object({ ...serviceInstanceRefShape, providerResourceId: z.string().min(1).max(200) }).strict();
var NETWORK_DENIAL_CLASSES = ["metadata", "private", "control_plane", "not_allowlisted"];
var networkDeniedPayloadV1Schema = z.object({ destinationClass: z.enum(NETWORK_DENIAL_CLASSES), reason: z.string().min(1).max(1e3) }).strict();
var TERMINAL_EVENT_STATUSES = ["succeeded", "failed", "cancelled", "expired"];
var terminalEventStatusSchema = z.enum(TERMINAL_EVENT_STATUSES);
var terminalEventPayloadV1Schema = z.object({
  status: terminalEventStatusSchema,
  exitCode: z.number().int().nullable(),
  errorCode: z.string().max(100).nullable(),
  errorMessage: z.string().max(4e3).nullable()
}).strict();
var eventBaseShape = {
  protocolVersion: z.literal(1),
  eventId: eventIdSchema,
  organizationId: organizationIdSchema,
  companyId: companyIdSchema,
  workerId: workerIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  leaseId: leaseIdSchema,
  fenceToken: fenceTokenSchema,
  seq: eventSequenceSchema,
  eventDigest: sha256DigestSchema,
  occurredAt: timestampV1Schema,
  extensions: wireExtensionsArraySchema
};
var eventVariant = (eventType, payload) => z.object({ ...eventBaseShape, eventType: z.literal(eventType), payload }).strict();
var WORKER_EVENT_TYPES = [
  "attempt_started",
  "log",
  "progress",
  "usage",
  "artifact_prepared",
  "browser_observation",
  "browser_approval_requested",
  "runtime_decision_requested",
  "service_instance_started",
  "service_health",
  "service_checkpoint_prepared",
  "service_checkpoint_restored",
  "service_graceful_stop_observed",
  "service_instance_stopped",
  "service_instance_lost",
  "service_provider_interrupted",
  "service_provider_resumed",
  "network_denied",
  "terminal"
];
var workerEventTypeSchema = z.enum(WORKER_EVENT_TYPES);
var workerEventV1Schema = z.discriminatedUnion("eventType", [
  eventVariant("attempt_started", attemptStartedPayloadV1Schema),
  eventVariant("log", logPayloadV1Schema),
  eventVariant("progress", progressPayloadV1Schema),
  eventVariant("usage", usagePayloadV1Schema),
  eventVariant("artifact_prepared", artifactPreparedPayloadV1Schema),
  eventVariant("browser_observation", browserObservationPayloadV1Schema),
  eventVariant("browser_approval_requested", browserApprovalRequestedPayloadV1Schema),
  eventVariant("runtime_decision_requested", runtimeDecisionRequestV1Schema),
  eventVariant("service_instance_started", serviceInstanceStartedPayloadV1Schema),
  eventVariant("service_health", serviceHealthPayloadV1Schema),
  eventVariant("service_checkpoint_prepared", serviceCheckpointPreparedPayloadV1Schema),
  eventVariant("service_checkpoint_restored", serviceCheckpointRestoredPayloadV1Schema),
  eventVariant("service_graceful_stop_observed", serviceGracefulStopObservedPayloadV1Schema),
  eventVariant("service_instance_stopped", serviceInstanceStoppedPayloadV1Schema),
  eventVariant("service_instance_lost", serviceInstanceLostPayloadV1Schema),
  eventVariant("service_provider_interrupted", serviceProviderInterruptedPayloadV1Schema),
  eventVariant("service_provider_resumed", serviceProviderResumedPayloadV1Schema),
  eventVariant("network_denied", networkDeniedPayloadV1Schema),
  eventVariant("terminal", terminalEventPayloadV1Schema)
]).superRefine((event, ctx) => {
  addForbiddenWireKeyIssues(event, ctx);
  addWireExtensionArrayIssues(event.extensions, ctx, ["extensions"]);
});
var deliveryIdentityShape = {
  protocolVersion: z.literal(1),
  organizationId: organizationIdSchema,
  companyId: companyIdSchema,
  workerId: workerIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  leaseId: leaseIdSchema,
  fenceToken: fenceTokenSchema
};
var workerEventBatchV1Schema = z.object({ ...deliveryIdentityShape, events: z.array(workerEventV1Schema).min(1).max(500) }).strict().superRefine((batch, ctx) => {
  addForbiddenWireKeyIssues(batch, ctx);
  const seenEventIds = /* @__PURE__ */ new Set();
  batch.events.forEach((event, index) => {
    const path = ["events", index];
    const mismatches = [
      ["organizationId", event.organizationId],
      ["companyId", event.companyId],
      ["workerId", event.workerId],
      ["jobId", event.jobId],
      ["leaseId", event.leaseId],
      ["fenceToken", event.fenceToken]
    ];
    for (const [field, value] of mismatches) {
      if (value !== batch[field]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, field], message: `event ${String(field)} must repeat the batch identity` });
      }
    }
    if (event.attempt !== batch.attempt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "attempt"], message: "event attempt must repeat the batch identity" });
    }
    if (seenEventIds.has(event.eventId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "eventId"], message: "duplicate event ID in batch" });
    }
    seenEventIds.add(event.eventId);
    if (index > 0 && event.seq !== batch.events[index - 1].seq + 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "seq"], message: "event sequences must be contiguous" });
    }
  });
});
var WORKER_EVENT_ACK_STATUSES = [
  "accepted",
  "gap",
  "hash_mismatch",
  "stale_fence",
  "target_revoked",
  "terminal"
];
var workerEventAckStatusSchema = z.enum(WORKER_EVENT_ACK_STATUSES);
var workerEventAckV1Schema = z.object({
  ...deliveryIdentityShape,
  acceptedThroughSeq: nonNegativeIntSchema2,
  expectedNextSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: workerEventAckStatusSchema,
  rejectedEventId: eventIdSchema.optional()
}).strict().superRefine((ack, ctx) => {
  addForbiddenWireKeyIssues(ack, ctx);
  if (ack.expectedNextSeq !== ack.acceptedThroughSeq + 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedNextSeq"], message: "expectedNextSeq must equal acceptedThroughSeq + 1" });
  }
  if (ack.status === "hash_mismatch") {
    if (ack.rejectedEventId === void 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rejectedEventId"], message: "hash_mismatch requires the conflicting rejectedEventId" });
    }
  } else if (ack.rejectedEventId !== void 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rejectedEventId"], message: "rejectedEventId is only valid for a hash_mismatch ACK" });
  }
});

// packages/worker-protocol/dist/capabilities.js
var KNOWN_WORKER_CAPABILITIES = [
  "workload.batch",
  "workload.browser_session",
  "workload.service",
  "provider.lifecycle_v1",
  "provider.cleanup_v1",
  "provider.checkpoint_v1",
  "provider.health_v1",
  "artifact.direct_upload",
  "secret.proxy",
  "sandbox.filesystem_isolated",
  "sandbox.process_isolated",
  "sandbox.filtered_egress"
];
var workerCapabilitySchema = z.enum(KNOWN_WORKER_CAPABILITIES);
var NON_EVENT_DISTRIBUTED_EMISSIONS = [
  "artifact_transfer_rejected",
  "quarantine_grant_issued",
  "quarantine_receipt_finalized",
  "replacement_lease_activated"
];
var KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS = /* @__PURE__ */ new Set([
  ...WORKER_EVENT_TYPES,
  ...NON_EVENT_DISTRIBUTED_EMISSIONS
]);
var nonNegativeIntSchema3 = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
var workerCapacitySchema = z.object({
  batchSlots: nonNegativeIntSchema3,
  browserSessionSlots: nonNegativeIntSchema3,
  serviceSlots: nonNegativeIntSchema3,
  freeCpuMillis: nonNegativeIntSchema3,
  freeMemoryMiB: nonNegativeIntSchema3,
  freeDiskMiB: nonNegativeIntSchema3
}).strict();
var WORKER_OS = ["linux", "darwin", "windows"];
var WORKER_ARCH = ["x64", "arm64"];
var workerPlatformSchema = z.object({
  os: z.enum(WORKER_OS),
  arch: z.enum(WORKER_ARCH),
  runtime: z.string().min(1).max(100)
}).strict();
var providerConstraintProfileRefV1Schema = providerConstraintRefV1Schema;
var PROVIDER_OPERATIONS = [
  "create",
  "execute",
  "cancel",
  "kill",
  "destroy",
  "list",
  "inspect",
  "reconcile_cleanup",
  "checkpoint",
  "restore",
  "health"
];
var providerOperationSchema = z.enum(PROVIDER_OPERATIONS);
var CORE_PROVIDER_OPERATIONS = [
  "create",
  "execute",
  "cancel",
  "kill",
  "destroy",
  "list",
  "inspect",
  "reconcile_cleanup"
];
var OPTIONAL_PROVIDER_OPERATIONS = ["checkpoint", "restore", "health"];
var providerProfileIdSchema = z.string().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
var localityTagSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/);
var CHECKPOINT_MODES = ["none", "snapshot", "application"];
var HEALTH_MODES = ["none", "poll", "stream"];
var providerConstraintProfileV1Schema = z.object({
  profileId: providerProfileIdSchema,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  digest: sha256DigestSchema,
  maxContinuousRuntimeSeconds: z.number().int().min(1).max(604800),
  maxIdleSeconds: z.number().int().min(1).max(86400),
  resourceCeiling: resourceLimitsSchema,
  maxConcurrentOperations: z.number().int().min(1).max(1e4),
  supportedOperations: z.array(providerOperationSchema).min(CORE_PROVIDER_OPERATIONS.length).max(PROVIDER_OPERATIONS.length),
  localityTags: z.array(localityTagSchema).min(1).max(32),
  checkpointMode: z.enum(CHECKPOINT_MODES),
  healthMode: z.enum(HEALTH_MODES)
}).strict().superRefine((profile, ctx) => {
  const ops = new Set(profile.supportedOperations);
  if (ops.size !== profile.supportedOperations.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["supportedOperations"], message: "duplicate provider operation" });
  }
  for (const core of CORE_PROVIDER_OPERATIONS) {
    if (!ops.has(core)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["supportedOperations"], message: `missing core provider operation ${core}` });
    }
  }
  const hasCheckpoint = ops.has("checkpoint");
  const hasRestore = ops.has("restore");
  if (hasCheckpoint !== hasRestore) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["supportedOperations"], message: "checkpoint and restore must appear together" });
  }
  const checkpointCapable = hasCheckpoint && hasRestore;
  if (checkpointCapable !== (profile.checkpointMode !== "none")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checkpointMode"], message: "checkpoint/restore require a non-none checkpoint mode and vice versa" });
  }
  if (ops.has("health") !== (profile.healthMode !== "none")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["healthMode"], message: "health requires a non-none health mode and vice versa" });
  }
  if (new Set(profile.localityTags).size !== profile.localityTags.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["localityTags"], message: "duplicate locality tag" });
  }
});
function canonicalProviderConstraintProfileDigestInputV1(profile) {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("provider-constraint profile must be a plain object");
  }
  const source = profile;
  const rest = {};
  for (const key of Object.keys(source)) {
    if (key === "digest")
      continue;
    rest[key] = source[key];
  }
  return new TextEncoder().encode(canonicalizeJsonV1(rest));
}
async function verifyAndBrandProviderConstraintProfileV1(profile, sha256Fn) {
  const parsed = providerConstraintProfileV1Schema.safeParse(profile);
  if (!parsed.success)
    return null;
  let input;
  try {
    input = canonicalProviderConstraintProfileDigestInputV1(parsed.data);
  } catch {
    return null;
  }
  let recomputed;
  try {
    recomputed = await sha256Fn(input);
  } catch {
    return null;
  }
  if (typeof recomputed !== "string" || recomputed !== String(parsed.data.digest))
    return null;
  return parsed.data;
}
var capabilityCeilingSchema = z.array(workerCapabilitySchema).max(KNOWN_WORKER_CAPABILITIES.length);
var registeredTargetProfileV1Schema = z.object({
  protocolVersion: z.literal(1),
  targetId: targetIdSchema,
  targetClass: targetClassSchema,
  scope: targetScopeSchema,
  organizationId: organizationIdSchema.nullable(),
  ownerPrincipalId: principalIdSchema.nullable(),
  trustCeiling: trustClassSchema,
  credentialCeiling: credentialKindSchema,
  dataLocalityCeiling: dataLocalitySchema,
  providerConstraints: providerConstraintProfileRefV1Schema,
  capabilityCeiling: capabilityCeilingSchema,
  deviceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revokedAt: timestampV1Schema.nullable(),
  policyHash: sha256DigestSchema
}).strict().superRefine((profile, ctx) => {
  if (profile.scope === "platform") {
    if (profile.organizationId !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["organizationId"], message: "platform scope requires a null organization" });
    }
    if (profile.ownerPrincipalId !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ownerPrincipalId"], message: "platform scope requires a null owner" });
    }
  } else if (profile.scope === "organization") {
    if (profile.organizationId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["organizationId"], message: "organization scope requires an organization" });
    }
    if (profile.ownerPrincipalId !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ownerPrincipalId"], message: "organization scope requires a null owner" });
    }
  } else {
    if (profile.organizationId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["organizationId"], message: "owner scope requires an organization" });
    }
    if (profile.ownerPrincipalId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ownerPrincipalId"], message: "owner scope requires an owner" });
    }
  }
  const row = PLACEMENT_MATRIX[profile.targetClass];
  if (row.targetScope !== profile.scope) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: `${profile.targetClass} requires scope ${row.targetScope}` });
  }
  if (row.trustClass !== profile.trustCeiling) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trustCeiling"], message: `${profile.targetClass} requires trust ${row.trustClass}` });
  }
  if (!row.credentials.includes(profile.credentialCeiling)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["credentialCeiling"], message: `credential ${profile.credentialCeiling} is not permitted for ${profile.targetClass}` });
  }
  if (!row.localities.includes(profile.dataLocalityCeiling)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dataLocalityCeiling"], message: `locality ${profile.dataLocalityCeiling} is not permitted for ${profile.targetClass}` });
  }
  if (new Set(profile.capabilityCeiling).size !== profile.capabilityCeiling.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilityCeiling"], message: "duplicate capability in the ceiling" });
  }
});
var protocolRangeSchema = z.object({
  min: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  max: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
}).strict().superRefine((range, ctx) => {
  if (range.min > range.max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["min"], message: "protocol range min must be <= max" });
  }
});
var workerHelloV1Schema = z.object({
  protocolVersion: z.literal(1),
  workerId: workerIdSchema,
  targetId: targetIdSchema,
  deviceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  agentVersion: z.string().min(1).max(100),
  supportedProtocol: protocolRangeSchema,
  platform: workerPlatformSchema,
  reportedCapabilities: z.array(workerCapabilitySchema).max(KNOWN_WORKER_CAPABILITIES.length),
  capacity: workerCapacitySchema,
  policyHash: sha256DigestSchema
}).strict().superRefine((hello, ctx) => {
  if (new Set(hello.reportedCapabilities).size !== hello.reportedCapabilities.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reportedCapabilities"], message: "duplicate reported capability" });
  }
});
var jobCapabilityRequirementsSchema = z.object({
  protocol: protocolRangeSchema,
  capabilities: z.array(workerCapabilitySchema).max(KNOWN_WORKER_CAPABILITIES.length),
  workloadType: workloadTypeSchema,
  targetRequirements: targetRequirementsV1Schema,
  policyHash: sha256DigestSchema,
  mustUnderstand: z.array(z.string().min(1).max(200)).max(64)
}).strict().superRefine((requirements, ctx) => {
  if (new Set(requirements.capabilities).size !== requirements.capabilities.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: "duplicate required capability" });
  }
  if (new Set(requirements.mustUnderstand).size !== requirements.mustUnderstand.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mustUnderstand"], message: "duplicate must-understand token" });
  }
});
function withinOrderedCeiling(row, requested, ceiling) {
  const ceilingIndex = row.indexOf(ceiling);
  const requestedIndex = row.indexOf(requested);
  return ceilingIndex >= 0 && requestedIndex >= 0 && requestedIndex <= ceilingIndex;
}
function refsEqual(ref, verified) {
  return String(ref.profileId) === String(verified.profileId) && ref.version === verified.version && String(ref.digest) === String(verified.digest);
}
function workerSatisfiesRequirements(profile, verifiedProviderConstraints, worker, requirements) {
  if (String(worker.targetId) !== String(profile.targetId))
    return false;
  if (worker.deviceGeneration !== profile.deviceGeneration)
    return false;
  if (profile.revokedAt !== null)
    return false;
  if (!refsEqual(profile.providerConstraints, verifiedProviderConstraints))
    return false;
  if (!refsEqual(requirements.targetRequirements.providerConstraints, verifiedProviderConstraints))
    return false;
  if (negotiateProtocolVersion(requirements.protocol, worker.supportedProtocol) === null)
    return false;
  if (String(requirements.policyHash) !== String(profile.policyHash))
    return false;
  if (String(worker.policyHash) !== String(profile.policyHash))
    return false;
  const ceiling = new Set(profile.capabilityCeiling.map(String));
  const reported = new Set(worker.reportedCapabilities.map(String));
  const effective = new Set([...ceiling].filter((cap) => reported.has(cap)));
  const workloadCapability = `workload.${requirements.workloadType}`;
  if (!effective.has(workloadCapability))
    return false;
  for (const required of requirements.capabilities) {
    if (!effective.has(String(required)))
      return false;
  }
  const knownCapabilities = new Set(KNOWN_WORKER_CAPABILITIES);
  for (const token of requirements.mustUnderstand) {
    if (!knownCapabilities.has(token))
      return false;
    if (!effective.has(token))
      return false;
  }
  const targetReq = requirements.targetRequirements;
  if (!targetReq.allowedTargetClasses.includes(profile.targetClass))
    return false;
  if (!targetReq.allowedTrustClasses.includes(profile.trustCeiling))
    return false;
  const row = PLACEMENT_MATRIX[profile.targetClass];
  if (row.trustClass !== profile.trustCeiling)
    return false;
  if (!row.credentials.includes(targetReq.credentialKind))
    return false;
  if (!row.localities.includes(targetReq.dataLocality))
    return false;
  if (!withinOrderedCeiling(row.credentials, targetReq.credentialKind, profile.credentialCeiling))
    return false;
  if (!withinOrderedCeiling(row.localities, targetReq.dataLocality, profile.dataLocalityCeiling))
    return false;
  if (targetReq.requiredOwnerPrincipalId !== null) {
    if (profile.ownerPrincipalId === null)
      return false;
    if (String(profile.ownerPrincipalId) !== String(targetReq.requiredOwnerPrincipalId))
      return false;
  }
  const ceilingResources = verifiedProviderConstraints.resourceCeiling;
  if (worker.capacity.freeCpuMillis > ceilingResources.cpuMillis)
    return false;
  if (worker.capacity.freeMemoryMiB > ceilingResources.memoryMiB)
    return false;
  if (worker.capacity.freeDiskMiB > ceilingResources.diskMiB)
    return false;
  const slots = {
    batch: worker.capacity.batchSlots,
    browser_session: worker.capacity.browserSessionSlots,
    service: worker.capacity.serviceSlots
  };
  if ((slots[requirements.workloadType] ?? 0) < 1)
    return false;
  return true;
}

// packages/worker-protocol/dist/errors.js
var PROTOCOL_ERROR_CODES = [
  "malformed",
  "unauthorized",
  "incompatible_protocol",
  "incompatible_capability",
  "incompatible_policy",
  "stale_fence",
  "sequence_gap",
  "target_revoked",
  "event_hash_mismatch",
  "throttled",
  "payload_too_large",
  "attempt_terminal",
  "internal_unavailable"
];
var protocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
var RETRYABLE_PROTOCOL_ERROR_CODES = ["throttled", "internal_unavailable"];
var RETRYABLE_SET = new Set(RETRYABLE_PROTOCOL_ERROR_CODES);
function isRetryableProtocolErrorCode(code) {
  return RETRYABLE_SET.has(code);
}
var KNOWN_SET = new Set(PROTOCOL_ERROR_CODES);
function isKnownProtocolErrorCode(value) {
  return typeof value === "string" && KNOWN_SET.has(value);
}
var nonNegativeIntSchema4 = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
var PROTOCOL_ERROR_DETAIL_LIMITS = {
  maxKeys: 16,
  maxKeyChars: 100,
  maxValueChars: 1e3,
  maxMessageChars: 1e3
};
var detailSchema = z.record(z.string().min(1).max(PROTOCOL_ERROR_DETAIL_LIMITS.maxKeyChars), z.string().max(PROTOCOL_ERROR_DETAIL_LIMITS.maxValueChars));
var protocolErrorV1Schema = z.object({
  protocolVersion: z.literal(1),
  code: protocolErrorCodeSchema,
  correlationId: z.string().uuid().nullable(),
  message: z.string().max(PROTOCOL_ERROR_DETAIL_LIMITS.maxMessageChars),
  retryAfterMs: nonNegativeIntSchema4.nullable(),
  serverTime: timestampV1Schema,
  redaction: z.literal("secret"),
  detail: detailSchema
}).strict().superRefine((error, ctx) => {
  addForbiddenWireKeyIssues(error, ctx);
  if (Object.keys(error.detail).length > PROTOCOL_ERROR_DETAIL_LIMITS.maxKeys) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["detail"], message: `at most ${PROTOCOL_ERROR_DETAIL_LIMITS.maxKeys} detail keys` });
  }
  if (isRetryableProtocolErrorCode(error.code)) {
    if (error.retryAfterMs === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retryAfterMs"], message: `${error.code} requires a bounded retryAfterMs` });
    }
  } else if (error.retryAfterMs !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retryAfterMs"], message: "retryAfterMs is only valid for a retryable error code" });
  }
});

// packages/worker-protocol/dist/transport.js
var encoder2 = new TextEncoder();
var nonNegativeIntSchema5 = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
var positiveIntSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
var correlationIdSchema = z.string().uuid();
var idempotencyKeySchema = z.string().uuid();
function boundedUtf82(maxBytes) {
  return z.string().min(1).superRefine((value, ctx) => {
    if (encoder2.encode(value).byteLength > maxBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `exceeds ${maxBytes} UTF-8 bytes` });
    }
  });
}
var nonceSchema = boundedUtf82(200);
var WORK_QUESTION_ANSWER_MAX_BYTES = 16384;
var WORK_QUESTION_ANSWER_MAX_DEPTH = 8;
function addBoundedJsonDepthIssues2(value, ctx, maxDepth) {
  const walk = (node, depth, path) => {
    if (Array.isArray(node)) {
      if (depth + 1 > maxDepth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `answer exceeds ${maxDepth} container levels` });
        return;
      }
      node.forEach((item, index) => walk(item, depth + 1, [...path, index]));
      return;
    }
    if (node !== null && typeof node === "object") {
      if (depth + 1 > maxDepth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `answer exceeds ${maxDepth} container levels` });
        return;
      }
      for (const key of Object.keys(node)) {
        walk(node[key], depth + 1, [...path, key]);
      }
    }
  };
  walk(value, 0, []);
}
var workQuestionAnswerValueSchema = z.unknown().superRefine((value, ctx) => {
  addBoundedJsonDepthIssues2(value, ctx, WORK_QUESTION_ANSWER_MAX_DEPTH);
  try {
    if (encoder2.encode(canonicalizeJsonV1(value)).byteLength > WORK_QUESTION_ANSWER_MAX_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `answer exceeds ${WORK_QUESTION_ANSWER_MAX_BYTES} canonical UTF-8 bytes` });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "answer is not canonicalizable" });
  }
});
var AUTH_AUDIENCES = [
  "target_enrollment",
  "worker_poll",
  "worker_run",
  "device_session",
  "control_channel"
];
var authAudienceSchema = z.enum(AUTH_AUDIENCES);
var requestEnvelopeShape = {
  protocolVersion: z.literal(1),
  correlationId: correlationIdSchema,
  issuedAt: timestampV1Schema,
  nonce: nonceSchema
};
var responseEnvelopeShape = {
  protocolVersion: z.literal(1),
  correlationId: correlationIdSchema,
  serverTime: timestampV1Schema
};
var controlDeliveryIdentityShape = {
  organizationId: organizationIdSchema,
  companyId: companyIdSchema,
  workerId: workerIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  leaseId: leaseIdSchema,
  fenceToken: fenceTokenSchema
};
function forbiddenKeyRefine(value, ctx) {
  addForbiddenWireKeyIssues(value, ctx);
}
var enrollmentRequestV1Schema = z.object({
  ...requestEnvelopeShape,
  audience: z.literal("target_enrollment"),
  idempotencyKey: idempotencyKeySchema,
  hello: workerHelloV1Schema
}).strict().superRefine(forbiddenKeyRefine);
var enrollmentResponseV1Schema = z.discriminatedUnion("outcome", [
  z.object({
    ...responseEnvelopeShape,
    outcome: z.literal("enrolled"),
    workerId: workerIdSchema,
    targetId: targetIdSchema,
    deviceGeneration: positiveIntSchema,
    providerConstraints: providerConstraintRefV1Schema
  }).strict(),
  z.object({
    ...responseEnvelopeShape,
    outcome: z.literal("rejected"),
    reason: protocolErrorCodeSchema,
    retryAfterMs: nonNegativeIntSchema5.nullable()
  }).strict()
]).superRefine(forbiddenKeyRefine);
var pollRequestV1Schema = z.object({
  ...requestEnvelopeShape,
  audience: z.literal("worker_poll"),
  workerId: workerIdSchema,
  targetId: targetIdSchema,
  deviceGeneration: positiveIntSchema,
  capacity: workerCapacitySchema
}).strict().superRefine(forbiddenKeyRefine);
var POLL_RESPONSE_OUTCOMES = ["offer", "no_work", "drain"];
var pollResponseV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...responseEnvelopeShape, outcome: z.literal("offer"), body: leaseOfferV1Schema }).strict(),
  z.object({ ...responseEnvelopeShape, outcome: z.literal("no_work"), retryAfterMs: nonNegativeIntSchema5 }).strict(),
  z.object({
    ...responseEnvelopeShape,
    outcome: z.literal("drain"),
    retryAfterMs: nonNegativeIntSchema5.nullable(),
    reason: z.string().max(1e3).nullable()
  }).strict()
]).superRefine(forbiddenKeyRefine);
var leaseAckOperationRequestV1Schema = z.object({
  ...requestEnvelopeShape,
  audience: z.literal("worker_run"),
  idempotencyKey: idempotencyKeySchema,
  body: leaseAckV1Schema
}).strict().superRefine(forbiddenKeyRefine);
var leaseAckOperationResponseV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...responseEnvelopeShape, outcome: z.literal("acknowledged"), leaseId: leaseIdSchema, expiresAt: timestampV1Schema }).strict(),
  z.object({ ...responseEnvelopeShape, outcome: z.literal("rejected"), reason: protocolErrorCodeSchema }).strict()
]).superRefine(forbiddenKeyRefine);
var leaseRenewOperationRequestV1Schema = z.object({
  ...requestEnvelopeShape,
  audience: z.literal("worker_run"),
  idempotencyKey: idempotencyKeySchema,
  body: leaseRenewRequestV1Schema
}).strict().superRefine(forbiddenKeyRefine);
var leaseRenewOperationResponseV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...responseEnvelopeShape, outcome: z.literal("renewed"), body: leaseRenewResponseV1Schema }).strict(),
  z.object({ ...responseEnvelopeShape, outcome: z.literal("rejected"), reason: protocolErrorCodeSchema }).strict()
]).superRefine(forbiddenKeyRefine);
var eventUploadOperationRequestV1Schema = z.object({
  ...requestEnvelopeShape,
  audience: z.literal("worker_run"),
  idempotencyKey: idempotencyKeySchema,
  body: workerEventBatchV1Schema
}).strict().superRefine(forbiddenKeyRefine);
var eventUploadOperationResponseV1Schema = z.object({ ...responseEnvelopeShape, ack: workerEventAckV1Schema }).strict().superRefine(forbiddenKeyRefine);
var artifactTransferGrantOperationRequestV1Schema = z.object({
  ...requestEnvelopeShape,
  audience: z.literal("worker_run"),
  idempotencyKey: idempotencyKeySchema,
  body: artifactTransferGrantRequestV1Schema
}).strict().superRefine(forbiddenKeyRefine);
var ARTIFACT_TRANSFER_GRANT_OUTCOMES = ["upload_granted", "download_granted", "rejected"];
var artifactTransferGrantOperationResponseV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...responseEnvelopeShape, outcome: z.literal("upload_granted"), grant: artifactUploadGrantV1Schema }).strict(),
  z.object({ ...responseEnvelopeShape, outcome: z.literal("download_granted"), grant: artifactDownloadGrantV1Schema }).strict(),
  z.object({ ...responseEnvelopeShape, outcome: z.literal("rejected"), reason: protocolErrorCodeSchema }).strict()
]).superRefine(forbiddenKeyRefine);
function isTransferGrantResponsePairedV1(requestOperation, responseOutcome) {
  if (responseOutcome === "rejected")
    return true;
  if (requestOperation === "upload")
    return responseOutcome === "upload_granted";
  if (requestOperation === "download")
    return responseOutcome === "download_granted";
  return false;
}
var artifactCommitOperationRequestV1Schema = z.object({
  ...requestEnvelopeShape,
  audience: z.literal("worker_run"),
  idempotencyKey: idempotencyKeySchema,
  body: artifactCommitPayloadV1Schema
}).strict().superRefine(forbiddenKeyRefine);
var ARTIFACT_COMMIT_OUTCOMES = ["committed", "rejected"];
var artifactCommitOperationResponseV1Schema = z.discriminatedUnion("outcome", [
  z.object({
    ...responseEnvelopeShape,
    outcome: z.literal("committed"),
    artifactId: artifactIdSchema,
    versionNumber: positiveIntSchema,
    committedAt: timestampV1Schema
  }).strict(),
  z.object({ ...responseEnvelopeShape, outcome: z.literal("rejected"), reason: protocolErrorCodeSchema }).strict()
]).superRefine(forbiddenKeyRefine);
var quarantineGrantOperationRequestV1Schema = z.object({
  ...requestEnvelopeShape,
  audience: z.literal("device_session"),
  idempotencyKey: idempotencyKeySchema,
  body: quarantineGrantPayloadV1Schema
}).strict().superRefine(forbiddenKeyRefine);
var quarantineGrantOperationResponseV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...responseEnvelopeShape, outcome: z.literal("quarantine_upload_granted"), grant: quarantineUploadGrantV1Schema }).strict(),
  z.object({ ...responseEnvelopeShape, outcome: z.literal("rejected"), reason: protocolErrorCodeSchema }).strict()
]).superRefine(forbiddenKeyRefine);
var quarantineFinalizeOperationRequestV1Schema = z.object({
  ...requestEnvelopeShape,
  audience: z.literal("device_session"),
  idempotencyKey: idempotencyKeySchema,
  body: quarantineFinalizePayloadV1Schema
}).strict().superRefine(forbiddenKeyRefine);
var quarantineFinalizeOperationResponseV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...responseEnvelopeShape, outcome: z.literal("quarantined"), receipt: quarantineUploadReceiptV1Schema }).strict(),
  z.object({ ...responseEnvelopeShape, outcome: z.literal("rejected"), reason: protocolErrorCodeSchema }).strict()
]).superRefine(forbiddenKeyRefine);
var PRODUCT_APPROVAL_DECISIONS = ["approved", "rejected", "expired"];
var productApprovalDecisionSchema = z.enum(PRODUCT_APPROVAL_DECISIONS);
var governedActionRefSchema = z.object({ kind: z.string().min(1).max(100), id: z.string().uuid() }).strict();
var productApprovalResultV1Schema = z.object({
  approvalId: z.string().uuid(),
  approvalKind: z.string().min(1).max(100),
  approvalVersion: positiveIntSchema,
  decision: productApprovalDecisionSchema,
  decidedBy: principalV1Schema,
  decidedAt: timestampV1Schema,
  idempotencyKey: idempotencyKeySchema,
  governedActionRef: governedActionRefSchema
}).strict().superRefine(forbiddenKeyRefine);
function productApprovalAuthorizesActionV1(result, action) {
  return result.decision === "approved" && String(result.governedActionRef.kind) === String(action.kind) && String(result.governedActionRef.id) === String(action.id);
}
var PERMISSION_DECISIONS = ["allow_once", "allow_run", "allow_always", "deny", "expired", "cancelled"];
var permissionDecisionSchema = z.enum(PERMISSION_DECISIONS);
var WORK_QUESTION_OUTCOMES = ["answered", "expired", "cancelled"];
var workQuestionOutcomeSchema = z.enum(WORK_QUESTION_OUTCOMES);
var runtimeDecisionResultCommonShape = {
  requestId: z.string().uuid(),
  nonce: nonceSchema,
  requestDigest: sha256DigestSchema,
  schemaVersion: positiveIntSchema,
  sourceRevision: nonNegativeIntSchema5,
  expiresAt: timestampV1Schema,
  decidedBy: principalV1Schema,
  decidedAt: timestampV1Schema,
  idempotencyKey: idempotencyKeySchema
};
var permissionRuntimeDecisionResultV1Schema = z.object({
  decisionKind: z.literal("permission"),
  ...runtimeDecisionResultCommonShape,
  timeoutPolicy: permissionTimeoutPolicySchema,
  decision: permissionDecisionSchema
}).strict();
var workQuestionRuntimeDecisionResultV1Schema = z.object({
  decisionKind: z.literal("work_question"),
  ...runtimeDecisionResultCommonShape,
  timeoutPolicy: workQuestionTimeoutPolicySchema,
  outcome: workQuestionOutcomeSchema,
  answer: workQuestionAnswerValueSchema.nullable()
}).strict();
var runtimeDecisionResultV1Schema = z.discriminatedUnion("decisionKind", [permissionRuntimeDecisionResultV1Schema, workQuestionRuntimeDecisionResultV1Schema]).superRefine((result, ctx) => {
  if (result.decisionKind !== "work_question")
    return;
  const answered = result.outcome === "answered";
  if (answered && result.answer === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["answer"], message: "an answered work question requires an answer" });
  }
  if (!answered && result.answer !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["answer"], message: "answer must be null unless the outcome is answered" });
  }
});
var RUNTIME_DECISION_MATCH_REASONS = [
  "missing_request",
  "kind_mismatch",
  "request_mismatch",
  "expired"
];
function matchRuntimeDecisionResultToRequestV1(request, result) {
  if (request === null || request === void 0)
    return { ok: false, reason: "missing_request" };
  if (request.decisionKind !== result.decisionKind)
    return { ok: false, reason: "kind_mismatch" };
  const echoed = [
    "requestId",
    "nonce",
    "requestDigest",
    "schemaVersion",
    "sourceRevision",
    "expiresAt",
    "timeoutPolicy"
  ];
  for (const field of echoed) {
    if (String(request[field]) !== String(result[field])) {
      return { ok: false, reason: "request_mismatch" };
    }
  }
  const positive = result.decisionKind === "permission" ? result.decision !== "expired" && result.decision !== "cancelled" : result.outcome === "answered";
  if (positive && Date.parse(result.decidedAt) > Date.parse(result.expiresAt)) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}
var CONTROL_COMMAND_KINDS = [
  "cancel",
  "product_approval_result",
  "runtime_decision_result",
  "checkpoint",
  "graceful_stop",
  "drain"
];
var controlCommandBaseShape = {
  protocolVersion: z.literal(1),
  audience: z.literal("control_channel"),
  commandId: z.string().uuid(),
  commandSeq: positiveIntSchema,
  idempotencyKey: idempotencyKeySchema,
  issuedAt: timestampV1Schema,
  nonce: nonceSchema,
  ...controlDeliveryIdentityShape
};
var controlCommandV1Schema = z.discriminatedUnion("commandKind", [
  z.object({ ...controlCommandBaseShape, commandKind: z.literal("cancel"), reason: z.string().max(1e3), graceful: z.boolean() }).strict(),
  z.object({ ...controlCommandBaseShape, commandKind: z.literal("product_approval_result"), result: productApprovalResultV1Schema }).strict(),
  z.object({ ...controlCommandBaseShape, commandKind: z.literal("runtime_decision_result"), result: runtimeDecisionResultV1Schema }).strict(),
  z.object({ ...controlCommandBaseShape, commandKind: z.literal("checkpoint"), deadline: timestampV1Schema }).strict(),
  z.object({ ...controlCommandBaseShape, commandKind: z.literal("graceful_stop"), deadline: timestampV1Schema }).strict(),
  z.object({ ...controlCommandBaseShape, commandKind: z.literal("drain"), reason: z.string().max(1e3).nullable() }).strict()
]).superRefine(forbiddenKeyRefine);
var CONTROL_ACK_STATUSES = ["accepted", "completed", "rejected", "stale"];
var controlCommandAckStatusSchema = z.enum(CONTROL_ACK_STATUSES);
var controlCommandAckV1Schema = z.object({
  protocolVersion: z.literal(1),
  correlationId: correlationIdSchema,
  commandId: z.string().uuid(),
  commandSeq: positiveIntSchema,
  status: controlCommandAckStatusSchema,
  observedAt: timestampV1Schema,
  detail: z.string().max(1e3).nullable()
}).strict().superRefine(forbiddenKeyRefine);
var CONTROL_RECEIVER_DECISIONS = ["accept", "replay", "gap", "conflict", "stale"];
var controlReceiverDecisionSchema = z.enum(CONTROL_RECEIVER_DECISIONS);
function decideControlReceiverV1(state, command) {
  if (state.priorForCommandId !== null) {
    return state.priorForCommandId.bodyDigest === command.bodyDigest ? "replay" : "conflict";
  }
  if (command.fenceToken !== state.activeFenceToken)
    return "stale";
  if (command.commandSeq <= state.acceptedThroughSeq)
    return "replay";
  if (command.commandSeq > state.acceptedThroughSeq + 1)
    return "gap";
  return "accept";
}
var EVENT_RECEIVER_DECISIONS = ["accept", "replay", "gap", "hash_mismatch", "stale_fence", "terminal"];
var eventReceiverDecisionSchema = z.enum(EVENT_RECEIVER_DECISIONS);
function decideEventReceiverV1(state, input) {
  if (input.suppliedDigest !== input.recomputedDigest)
    return "hash_mismatch";
  if (input.fenceToken !== state.activeFenceToken)
    return "stale_fence";
  if (state.terminalReached)
    return "terminal";
  if (state.priorDigestForEventId !== null) {
    return state.priorDigestForEventId === input.recomputedDigest ? "replay" : "hash_mismatch";
  }
  if (input.seq <= state.acceptedThroughSeq)
    return "replay";
  if (input.seq > state.acceptedThroughSeq + 1)
    return "gap";
  return "accept";
}
var WORKER_PROTOCOL_OPERATIONS = [
  "enrollment",
  "poll",
  "lease_ack",
  "lease_renew",
  "event_upload",
  "artifact_transfer_grant",
  "artifact_commit",
  "quarantine_grant",
  "quarantine_finalize",
  "control_command"
];
var KiB = 1024;
var MiB = 1024 * 1024;
var OPERATION_DESCRIPTORS = {
  enrollment: {
    operation: "enrollment",
    audience: "target_enrollment",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 256 * KiB,
    timeoutMs: 15e3,
    successOutcomes: ["enrolled", "rejected"],
    errors: ["malformed", "unauthorized", "incompatible_protocol", "incompatible_policy", "throttled", "internal_unavailable"]
  },
  poll: {
    operation: "poll",
    audience: "worker_poll",
    idempotent: false,
    retry: "safe_read",
    maxRequestBytes: 64 * KiB,
    timeoutMs: 3e4,
    successOutcomes: ["offer", "no_work", "drain"],
    errors: [
      "malformed",
      "unauthorized",
      "incompatible_protocol",
      "incompatible_capability",
      "incompatible_policy",
      "target_revoked",
      "throttled",
      "internal_unavailable"
    ]
  },
  lease_ack: {
    operation: "lease_ack",
    audience: "worker_run",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 64 * KiB,
    timeoutMs: 15e3,
    successOutcomes: ["acknowledged", "rejected"],
    errors: ["malformed", "unauthorized", "stale_fence", "target_revoked", "attempt_terminal", "throttled", "internal_unavailable"]
  },
  lease_renew: {
    operation: "lease_renew",
    audience: "worker_run",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 64 * KiB,
    timeoutMs: 15e3,
    successOutcomes: ["renewed", "rejected"],
    errors: ["malformed", "unauthorized", "stale_fence", "target_revoked", "attempt_terminal", "throttled", "internal_unavailable"]
  },
  event_upload: {
    operation: "event_upload",
    audience: "worker_run",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 4 * MiB,
    timeoutMs: 3e4,
    successOutcomes: ["accepted", "gap", "hash_mismatch", "stale_fence", "target_revoked", "terminal"],
    errors: [
      "malformed",
      "unauthorized",
      "stale_fence",
      "sequence_gap",
      "event_hash_mismatch",
      "target_revoked",
      "attempt_terminal",
      "payload_too_large",
      "throttled",
      "internal_unavailable"
    ]
  },
  artifact_transfer_grant: {
    operation: "artifact_transfer_grant",
    audience: "worker_run",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 64 * KiB,
    timeoutMs: 15e3,
    successOutcomes: ["upload_granted", "download_granted", "rejected"],
    errors: ["malformed", "unauthorized", "stale_fence", "target_revoked", "payload_too_large", "throttled", "internal_unavailable"]
  },
  artifact_commit: {
    operation: "artifact_commit",
    audience: "worker_run",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 256 * KiB,
    timeoutMs: 15e3,
    successOutcomes: ["committed", "rejected"],
    errors: ["malformed", "unauthorized", "stale_fence", "target_revoked", "attempt_terminal", "throttled", "internal_unavailable"]
  },
  quarantine_grant: {
    operation: "quarantine_grant",
    audience: "device_session",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 64 * KiB,
    timeoutMs: 15e3,
    successOutcomes: ["quarantine_upload_granted", "rejected"],
    errors: ["malformed", "unauthorized", "target_revoked", "payload_too_large", "throttled", "internal_unavailable"]
  },
  quarantine_finalize: {
    operation: "quarantine_finalize",
    audience: "device_session",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 256 * KiB,
    timeoutMs: 15e3,
    successOutcomes: ["quarantined", "rejected"],
    errors: ["malformed", "unauthorized", "target_revoked", "event_hash_mismatch", "payload_too_large", "throttled", "internal_unavailable"]
  },
  control_command: {
    operation: "control_command",
    audience: "control_channel",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 256 * KiB,
    timeoutMs: 15e3,
    successOutcomes: ["accepted", "completed", "rejected", "stale"],
    errors: ["malformed", "unauthorized", "stale_fence", "attempt_terminal", "throttled", "internal_unavailable"]
  }
};
export {
  ARTIFACT_COMMIT_OUTCOMES,
  ARTIFACT_KINDS,
  ARTIFACT_RETENTION_CLASSES,
  ARTIFACT_TRANSFER_GRANT_OUTCOMES,
  ATTEMPT_STATUSES,
  AUTH_AUDIENCES,
  BROWSER_SESSION_STATUSES,
  CHECKPOINT_MODES,
  CONTROL_ACK_STATUSES,
  CONTROL_COMMAND_KINDS,
  CONTROL_RECEIVER_DECISIONS,
  CORE_PROVIDER_OPERATIONS,
  CREDENTIAL_KINDS,
  CanonicalJsonError,
  DATA_LOCALITIES,
  EVENT_RECEIVER_DECISIONS,
  EXECUTION_SOURCE_KINDS,
  FALLBACK_MODES,
  FORBIDDEN_WIRE_KEYS,
  HEALTH_MODES,
  JOB_STATUSES,
  JOB_TRANSITION_REASONS,
  KNOWN_CRITICAL_EXTENSION_NAMESPACES,
  KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS,
  KNOWN_WORKER_CAPABILITIES,
  LEASE_STATUSES,
  LOG_LEVELS,
  LOG_STREAMS,
  MIN_PROTOCOL_VERSION,
  NETWORK_DENIAL_CLASSES,
  NON_EVENT_DISTRIBUTED_EMISSIONS,
  OFFLINE_POLICIES,
  ONE_SHOT_OPERATION_KINDS,
  OPERATION_DESCRIPTORS,
  OPTIONAL_PROVIDER_OPERATIONS,
  PATCH_OPERATION_KINDS,
  PERMISSION_DECISIONS,
  PERMISSION_DEFAULT_DECISIONS,
  PERMISSION_TIMEOUT_POLICIES,
  PLACEMENT_MATRIX,
  POLL_RESPONSE_OUTCOMES,
  PRINCIPAL_TYPES,
  PRODUCT_APPROVAL_DECISIONS,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_ERROR_DETAIL_LIMITS,
  PROTOCOL_VERSION,
  PROVIDER_OPERATIONS,
  QUARANTINE_REASONS,
  RESTRICTED_ARTIFACT_KINDS,
  RETRYABLE_PROTOCOL_ERROR_CODES,
  RUNTIME_DECISION_MATCH_REASONS,
  SECRET_MATERIALIZATION_KINDS,
  SECRET_USE_POLICIES,
  SERVICE_DESIRED_STATES,
  SERVICE_HEALTH_STATUSES,
  SERVICE_INSTANCE_STATUSES,
  TARGET_CLASSES,
  TARGET_SCOPES,
  TERMINAL_EVENT_STATUSES,
  TRUST_CLASSES,
  WIRE_EXTENSION_LIMITS,
  WORKER_ARCH,
  WORKER_EVENT_ACK_STATUSES,
  WORKER_EVENT_TYPES,
  WORKER_OS,
  WORKER_PROTOCOL_OPERATIONS,
  WORKLOAD_TYPES,
  WORKSPACE_ENTRY_KINDS,
  WORKSPACE_PROVENANCE,
  WORK_QUESTION_OUTCOMES,
  WORK_QUESTION_TIMEOUT_POLICIES,
  adapterRefV1Schema,
  addForbiddenWireKeyIssues,
  addWireExtensionArrayIssues,
  agentIdSchema,
  artifactCommitOperationRequestV1Schema,
  artifactCommitOperationResponseV1Schema,
  artifactCommitPayloadV1Schema,
  artifactDownloadGrantV1Schema,
  artifactIdSchema,
  artifactKindSchema,
  artifactManifestV1Schema,
  artifactPreparedPayloadV1Schema,
  artifactRetentionClassSchema,
  artifactSensitivitySchema,
  artifactTransferGrantOperationRequestV1Schema,
  artifactTransferGrantOperationResponseV1Schema,
  artifactTransferGrantRequestV1Schema,
  artifactUploadGrantV1Schema,
  attemptNumberSchema,
  attemptStartedPayloadV1Schema,
  attemptStatusSchema,
  authAudienceSchema,
  batchWorkloadV1Schema,
  browserApprovalRequestedPayloadV1Schema,
  browserObservationPayloadV1Schema,
  browserRequestIdSchema,
  browserRequestSourceSchema,
  browserSessionStatusSchema,
  browserWorkloadV1Schema,
  canTransitionAttemptStatus,
  canTransitionBrowserSessionStatus,
  canTransitionJobStatus,
  canTransitionLeaseStatus,
  canTransitionServiceDesiredState,
  canTransitionServiceInstanceStatus,
  canonicalEventDigestInputV1,
  canonicalProviderConstraintProfileDigestInputV1,
  canonicalizeJsonV1,
  clearRegisteredSecretCanaries,
  commanderTurnSourceSchema,
  companyIdSchema,
  controlCommandAckStatusSchema,
  controlCommandAckV1Schema,
  controlCommandV1Schema,
  controlReceiverDecisionSchema,
  conversationIdSchema,
  createSeededRng,
  credentialKindSchema,
  crewRunIdSchema,
  crewRunSourceSchema,
  dataLocalitySchema,
  decideControlReceiverV1,
  decideEventReceiverV1,
  enrollmentRequestV1Schema,
  enrollmentResponseV1Schema,
  eventIdSchema,
  eventReceiverDecisionSchema,
  eventSequenceSchema,
  eventUploadOperationRequestV1Schema,
  eventUploadOperationResponseV1Schema,
  executionSourceV1Schema,
  expectedAttemptObjectPrefix,
  expectedQuarantineObjectPrefix,
  fallbackModeSchema,
  fenceTokenSchema,
  findForbiddenWireKeys,
  findSecretCanaryStringMatches,
  generateWireStringSample,
  getRegisteredSecretCanaries,
  governedActionRefSchema,
  internalAgentRunIdSchema,
  isKnownProtocolErrorCode,
  isRetryableProtocolErrorCode,
  isSafeWorkspacePath,
  isTargetPlacementAllowed,
  isTransferGrantResponsePairedV1,
  issueIdSchema,
  jobCapabilityRequirementsSchema,
  jobEnvelopeV1Schema,
  jobIdSchema,
  jobStatusSchema,
  jobTransitionReasonSchema,
  leaseAckOperationRequestV1Schema,
  leaseAckOperationResponseV1Schema,
  leaseAckV1Schema,
  leaseIdSchema,
  leaseOfferV1Schema,
  leaseRenewOperationRequestV1Schema,
  leaseRenewOperationResponseV1Schema,
  leaseRenewRequestV1Schema,
  leaseRenewResponseV1Schema,
  leaseStatusSchema,
  logPayloadV1Schema,
  matchRuntimeDecisionResultToRequestV1,
  negotiateProtocolVersion,
  networkAllowRuleSchema,
  networkDeniedPayloadV1Schema,
  networkPolicyRefSchema,
  networkPolicyV1Schema,
  normalizeWireKey,
  offlinePolicySchema,
  oneShotOperationIdSchema,
  oneShotOperationKindSchema,
  oneShotSourceSchema,
  organizationIdSchema,
  patchOperationSchema,
  permissionDecisionSchema,
  permissionDefaultDecisionSchema,
  permissionRuntimeDecisionRequestV1Schema,
  permissionRuntimeDecisionResultV1Schema,
  permissionTimeoutPolicySchema,
  placementV1Schema,
  pollRequestV1Schema,
  pollResponseV1Schema,
  principalIdSchema,
  principalTypeSchema,
  principalV1Schema,
  productApprovalAuthorizesActionV1,
  productApprovalDecisionSchema,
  productApprovalResultV1Schema,
  progressPayloadV1Schema,
  protocolErrorCodeSchema,
  protocolErrorV1Schema,
  providerConstraintProfileRefV1Schema,
  providerConstraintProfileV1Schema,
  providerConstraintRefV1Schema,
  providerOperationSchema,
  quarantineFinalizeOperationRequestV1Schema,
  quarantineFinalizeOperationResponseV1Schema,
  quarantineFinalizePayloadV1Schema,
  quarantineGrantOperationRequestV1Schema,
  quarantineGrantOperationResponseV1Schema,
  quarantineGrantPayloadV1Schema,
  quarantineReasonSchema,
  quarantineUploadGrantV1Schema,
  quarantineUploadReceiptV1Schema,
  reconciliationIdSchema,
  registerSecretCanaries,
  registeredTargetProfileV1Schema,
  resourceLimitsSchema,
  runIdSchema,
  runtimeDecisionRequestV1Schema,
  runtimeDecisionResultV1Schema,
  sandboxIdSchema,
  secretHandleIdSchema,
  secretHandleRefSchema,
  secretMaterializationSchema,
  secretUsePolicySchema,
  serviceCheckpointPreparedPayloadV1Schema,
  serviceCheckpointRestoredPayloadV1Schema,
  serviceDesiredStateSchema,
  serviceGracefulStopObservedPayloadV1Schema,
  serviceHealthPayloadV1Schema,
  serviceIdSchema,
  serviceInstanceIdSchema,
  serviceInstanceLostPayloadV1Schema,
  serviceInstanceStartedPayloadV1Schema,
  serviceInstanceStatusSchema,
  serviceInstanceStoppedPayloadV1Schema,
  serviceProviderInterruptedPayloadV1Schema,
  serviceProviderResumedPayloadV1Schema,
  serviceReconcileSourceSchema,
  serviceWorkloadV1Schema,
  sha256DigestSchema,
  targetClassSchema,
  targetIdSchema,
  targetRequirementsV1Schema,
  targetScopeSchema,
  taskRunSourceSchema,
  terminalEventPayloadV1Schema,
  terminalEventStatusSchema,
  timestampV1Schema,
  trustClassSchema,
  usagePayloadV1Schema,
  verifyAndBrandProviderConstraintProfileV1,
  verifyWorkerEventDigestV1,
  visitWireStrings,
  wireExtensionSchema,
  wireExtensionsArraySchema,
  workQuestionOptionV1Schema,
  workQuestionOutcomeSchema,
  workQuestionRuntimeDecisionRequestV1Schema,
  workQuestionRuntimeDecisionResultV1Schema,
  workQuestionTimeoutPolicySchema,
  workerCapabilitySchema,
  workerCapacitySchema,
  workerEventAckStatusSchema,
  workerEventAckV1Schema,
  workerEventBatchV1Schema,
  workerEventTypeSchema,
  workerEventV1Schema,
  workerHelloV1Schema,
  workerIdSchema,
  workerPlatformSchema,
  workerSatisfiesRequirements,
  workloadTypeSchema,
  workspaceBaseV1Schema2 as workspaceBaseV1Schema,
  workspaceEntryKindSchema,
  workspaceEntrySchema,
  workspaceManifestV1Schema,
  workspacePatchManifestV1Schema,
  workspacePathSchema,
  workspaceProvenanceSchema,
  workspaceV1Schema
};
