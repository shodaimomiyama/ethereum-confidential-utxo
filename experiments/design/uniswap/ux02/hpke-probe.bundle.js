(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b2) => (typeof require !== "undefined" ? require : a)[b2]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod4, isNodeMode, target) => (target = mod4 != null ? __create(__getProtoOf(mod4)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod4 || !mod4.__esModule ? __defProp(target, "default", { value: mod4, enumerable: true }) : target,
    mod4
  ));

  // node_modules/ethers/lib.esm/_version.js
  var version = "6.17.0";

  // node_modules/ethers/lib.esm/utils/properties.js
  function checkType(value, type, name) {
    const types = type.split("|").map((t) => t.trim());
    for (let i = 0; i < types.length; i++) {
      switch (type) {
        case "any":
          return;
        case "bigint":
        case "boolean":
        case "number":
        case "string":
          if (typeof value === type) {
            return;
          }
      }
    }
    const error = new Error(`invalid value for type ${type}`);
    error.code = "INVALID_ARGUMENT";
    error.argument = `value.${name}`;
    error.value = value;
    throw error;
  }
  function defineProperties(target, values, types) {
    for (let key in values) {
      let value = values[key];
      const type = types ? types[key] : null;
      if (type) {
        checkType(value, type, key);
      }
      Object.defineProperty(target, key, { enumerable: true, value, writable: false });
    }
  }

  // node_modules/ethers/lib.esm/utils/errors.js
  function stringify(value, seen) {
    if (value == null) {
      return "null";
    }
    if (seen == null) {
      seen = /* @__PURE__ */ new Set();
    }
    if (typeof value === "object") {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    if (Array.isArray(value)) {
      return "[ " + value.map((v) => stringify(v, seen)).join(", ") + " ]";
    }
    if (value instanceof Uint8Array) {
      const HEX2 = "0123456789abcdef";
      let result = "0x";
      for (let i = 0; i < value.length; i++) {
        result += HEX2[value[i] >> 4];
        result += HEX2[value[i] & 15];
      }
      return result;
    }
    if (typeof value === "object" && typeof value.toJSON === "function") {
      return stringify(value.toJSON(), seen);
    }
    switch (typeof value) {
      case "boolean":
      case "number":
      case "symbol":
        return value.toString();
      case "bigint":
        return BigInt(value).toString();
      case "string":
        return JSON.stringify(value);
      case "object": {
        const keys = Object.keys(value);
        keys.sort();
        return "{ " + keys.map((k) => `${stringify(k, seen)}: ${stringify(value[k], seen)}`).join(", ") + " }";
      }
    }
    return `[ COULD NOT SERIALIZE ]`;
  }
  function isError(error, code) {
    return error && error.code === code;
  }
  function makeError(message, code, info) {
    let shortMessage = message;
    {
      const details = [];
      if (info) {
        if ("message" in info || "code" in info || "name" in info) {
          throw new Error(`value will overwrite populated values: ${stringify(info)}`);
        }
        for (const key in info) {
          if (key === "shortMessage") {
            continue;
          }
          const value = info[key];
          details.push(key + "=" + stringify(value));
        }
      }
      details.push(`code=${code}`);
      details.push(`version=${version}`);
      if (details.length) {
        message += " (" + details.join(", ") + ")";
      }
    }
    let error;
    switch (code) {
      case "INVALID_ARGUMENT":
        error = new TypeError(message);
        break;
      case "NUMERIC_FAULT":
      case "BUFFER_OVERRUN":
        error = new RangeError(message);
        break;
      default:
        error = new Error(message);
    }
    defineProperties(error, { code });
    if (info) {
      Object.assign(error, info);
    }
    if (error.shortMessage == null) {
      defineProperties(error, { shortMessage });
    }
    return error;
  }
  function assert(check, message, code, info) {
    if (!check) {
      throw makeError(message, code, info);
    }
  }
  function assertArgument(check, message, name, value) {
    assert(check, message, "INVALID_ARGUMENT", { argument: name, value });
  }
  function assertArgumentCount(count, expectedCount, message) {
    if (message == null) {
      message = "";
    }
    if (message) {
      message = ": " + message;
    }
    assert(count >= expectedCount, "missing argument" + message, "MISSING_ARGUMENT", {
      count,
      expectedCount
    });
    assert(count <= expectedCount, "too many arguments" + message, "UNEXPECTED_ARGUMENT", {
      count,
      expectedCount
    });
  }
  var _normalizeForms = ["NFD", "NFC", "NFKD", "NFKC"].reduce((accum, form) => {
    try {
      if ("test".normalize(form) !== "test") {
        throw new Error("bad");
      }
      ;
      if (form === "NFD") {
        const check = String.fromCharCode(233).normalize("NFD");
        const expected = String.fromCharCode(101, 769);
        if (check !== expected) {
          throw new Error("broken");
        }
      }
      accum.push(form);
    } catch (error) {
    }
    return accum;
  }, []);
  function assertNormalize(form) {
    assert(_normalizeForms.indexOf(form) >= 0, "platform missing String.prototype.normalize", "UNSUPPORTED_OPERATION", {
      operation: "String.prototype.normalize",
      info: { form }
    });
  }
  function assertPrivate(givenGuard, guard, className) {
    if (className == null) {
      className = "";
    }
    if (givenGuard !== guard) {
      let method = className, operation = "new";
      if (className) {
        method += ".";
        operation += " " + className;
      }
      assert(false, `private constructor; use ${method}from* methods`, "UNSUPPORTED_OPERATION", {
        operation
      });
    }
  }

  // node_modules/ethers/lib.esm/utils/data.js
  function _getBytes(value, name, copy) {
    if (value instanceof Uint8Array) {
      if (copy) {
        return new Uint8Array(value);
      }
      return value;
    }
    if (typeof value === "string" && value.length % 2 === 0 && value.match(/^0x[0-9a-f]*$/i)) {
      const result = new Uint8Array((value.length - 2) / 2);
      let offset = 2;
      for (let i = 0; i < result.length; i++) {
        result[i] = parseInt(value.substring(offset, offset + 2), 16);
        offset += 2;
      }
      return result;
    }
    assertArgument(false, "invalid BytesLike value", name || "value", value);
  }
  function getBytes(value, name) {
    return _getBytes(value, name, false);
  }
  function getBytesCopy(value, name) {
    return _getBytes(value, name, true);
  }
  function isHexString(value, length) {
    if (typeof value !== "string" || !value.match(/^0x[0-9A-Fa-f]*$/)) {
      return false;
    }
    if (typeof length === "number" && value.length !== 2 + 2 * length) {
      return false;
    }
    if (length === true && value.length % 2 !== 0) {
      return false;
    }
    return true;
  }
  var HexCharacters = "0123456789abcdef";
  function hexlify(data) {
    const bytes2 = getBytes(data);
    let result = "0x";
    for (let i = 0; i < bytes2.length; i++) {
      const v = bytes2[i];
      result += HexCharacters[(v & 240) >> 4] + HexCharacters[v & 15];
    }
    return result;
  }
  function concat(datas) {
    return "0x" + datas.map((d) => hexlify(d).substring(2)).join("");
  }
  function dataLength(data) {
    if (isHexString(data, true)) {
      return (data.length - 2) / 2;
    }
    return getBytes(data).length;
  }
  function zeroPad(data, length, left) {
    const bytes2 = getBytes(data);
    assert(length >= bytes2.length, "padding exceeds data length", "BUFFER_OVERRUN", {
      buffer: new Uint8Array(bytes2),
      length,
      offset: length + 1
    });
    const result = new Uint8Array(length);
    result.fill(0);
    if (left) {
      result.set(bytes2, length - bytes2.length);
    } else {
      result.set(bytes2, 0);
    }
    return hexlify(result);
  }
  function zeroPadValue(data, length) {
    return zeroPad(data, length, true);
  }

  // node_modules/ethers/lib.esm/utils/maths.js
  var BN_0 = BigInt(0);
  var BN_1 = BigInt(1);
  var maxValue = 9007199254740991;
  function fromTwos(_value, _width) {
    const value = getUint(_value, "value");
    const width = BigInt(getNumber(_width, "width"));
    assert(value >> width === BN_0, "overflow", "NUMERIC_FAULT", {
      operation: "fromTwos",
      fault: "overflow",
      value: _value
    });
    if (value >> width - BN_1) {
      const mask2 = (BN_1 << width) - BN_1;
      return -((~value & mask2) + BN_1);
    }
    return value;
  }
  function toTwos(_value, _width) {
    let value = getBigInt(_value, "value");
    const width = BigInt(getNumber(_width, "width"));
    const limit = BN_1 << width - BN_1;
    if (value < BN_0) {
      value = -value;
      assert(value <= limit, "too low", "NUMERIC_FAULT", {
        operation: "toTwos",
        fault: "overflow",
        value: _value
      });
      const mask2 = (BN_1 << width) - BN_1;
      return (~value & mask2) + BN_1;
    } else {
      assert(value < limit, "too high", "NUMERIC_FAULT", {
        operation: "toTwos",
        fault: "overflow",
        value: _value
      });
    }
    return value;
  }
  function mask(_value, _bits) {
    const value = getUint(_value, "value");
    const bits = BigInt(getNumber(_bits, "bits"));
    return value & (BN_1 << bits) - BN_1;
  }
  function getBigInt(value, name) {
    switch (typeof value) {
      case "bigint":
        return value;
      case "number":
        assertArgument(Number.isInteger(value), "underflow", name || "value", value);
        assertArgument(value >= -maxValue && value <= maxValue, "overflow", name || "value", value);
        return BigInt(value);
      case "string":
        try {
          if (value === "") {
            throw new Error("empty string");
          }
          if (value[0] === "-" && value[1] !== "-") {
            return -BigInt(value.substring(1));
          }
          return BigInt(value);
        } catch (e) {
          assertArgument(false, `invalid BigNumberish string: ${e.message}`, name || "value", value);
        }
    }
    assertArgument(false, "invalid BigNumberish value", name || "value", value);
  }
  function getUint(value, name) {
    const result = getBigInt(value, name);
    assert(result >= BN_0, "unsigned value cannot be negative", "NUMERIC_FAULT", {
      fault: "overflow",
      operation: "getUint",
      value
    });
    return result;
  }
  var Nibbles = "0123456789abcdef";
  function toBigInt(value) {
    if (value instanceof Uint8Array) {
      let result = "0x0";
      for (const v of value) {
        result += Nibbles[v >> 4];
        result += Nibbles[v & 15];
      }
      return BigInt(result);
    }
    return getBigInt(value);
  }
  function getNumber(value, name) {
    switch (typeof value) {
      case "bigint":
        assertArgument(value >= -maxValue && value <= maxValue, "overflow", name || "value", value);
        return Number(value);
      case "number":
        assertArgument(Number.isInteger(value), "underflow", name || "value", value);
        assertArgument(value >= -maxValue && value <= maxValue, "overflow", name || "value", value);
        return value;
      case "string":
        try {
          if (value === "") {
            throw new Error("empty string");
          }
          return getNumber(BigInt(value), name);
        } catch (e) {
          assertArgument(false, `invalid numeric string: ${e.message}`, name || "value", value);
        }
    }
    assertArgument(false, "invalid numeric value", name || "value", value);
  }
  function toNumber(value) {
    return getNumber(toBigInt(value));
  }
  function toBeHex(_value, _width) {
    const value = getUint(_value, "value");
    let result = value.toString(16);
    if (_width == null) {
      if (result.length % 2) {
        result = "0" + result;
      }
    } else {
      const width = getNumber(_width, "width");
      if (width === 0 && value === BN_0) {
        return "0x";
      }
      assert(width * 2 >= result.length, `value exceeds width (${width} bytes)`, "NUMERIC_FAULT", {
        operation: "toBeHex",
        fault: "overflow",
        value: _value
      });
      while (result.length < width * 2) {
        result = "0" + result;
      }
    }
    return "0x" + result;
  }
  function toBeArray(_value, _width) {
    const value = getUint(_value, "value");
    if (value === BN_0) {
      const width = _width != null ? getNumber(_width, "width") : 0;
      return new Uint8Array(width);
    }
    let hex = value.toString(16);
    if (hex.length % 2) {
      hex = "0" + hex;
    }
    if (_width != null) {
      const width = getNumber(_width, "width");
      while (hex.length < width * 2) {
        hex = "00" + hex;
      }
      assert(width * 2 === hex.length, `value exceeds width (${width} bytes)`, "NUMERIC_FAULT", {
        operation: "toBeArray",
        fault: "overflow",
        value: _value
      });
    }
    const result = new Uint8Array(hex.length / 2);
    for (let i = 0; i < result.length; i++) {
      const offset = i * 2;
      result[i] = parseInt(hex.substring(offset, offset + 2), 16);
    }
    return result;
  }

  // node_modules/ethers/lib.esm/utils/utf8.js
  function errorFunc(reason, offset, bytes2, output3, badCodepoint) {
    assertArgument(false, `invalid codepoint at offset ${offset}; ${reason}`, "bytes", bytes2);
  }
  function ignoreFunc(reason, offset, bytes2, output3, badCodepoint) {
    if (reason === "BAD_PREFIX" || reason === "UNEXPECTED_CONTINUE") {
      let i = 0;
      for (let o = offset + 1; o < bytes2.length; o++) {
        if (bytes2[o] >> 6 !== 2) {
          break;
        }
        i++;
      }
      return i;
    }
    if (reason === "OVERRUN") {
      return bytes2.length - offset - 1;
    }
    return 0;
  }
  function replaceFunc(reason, offset, bytes2, output3, badCodepoint) {
    if (reason === "OVERLONG") {
      assertArgument(typeof badCodepoint === "number", "invalid bad code point for replacement", "badCodepoint", badCodepoint);
      output3.push(badCodepoint);
      return 0;
    }
    output3.push(65533);
    return ignoreFunc(reason, offset, bytes2, output3, badCodepoint);
  }
  var Utf8ErrorFuncs = Object.freeze({
    error: errorFunc,
    ignore: ignoreFunc,
    replace: replaceFunc
  });
  function getUtf8CodePoints(_bytes, onError) {
    if (onError == null) {
      onError = Utf8ErrorFuncs.error;
    }
    const bytes2 = getBytes(_bytes, "bytes");
    const result = [];
    let i = 0;
    while (i < bytes2.length) {
      const c = bytes2[i++];
      if (c >> 7 === 0) {
        result.push(c);
        continue;
      }
      let extraLength = null;
      let overlongMask = null;
      if ((c & 224) === 192) {
        extraLength = 1;
        overlongMask = 127;
      } else if ((c & 240) === 224) {
        extraLength = 2;
        overlongMask = 2047;
      } else if ((c & 248) === 240) {
        extraLength = 3;
        overlongMask = 65535;
      } else {
        if ((c & 192) === 128) {
          i += onError("UNEXPECTED_CONTINUE", i - 1, bytes2, result);
        } else {
          i += onError("BAD_PREFIX", i - 1, bytes2, result);
        }
        continue;
      }
      if (i - 1 + extraLength >= bytes2.length) {
        i += onError("OVERRUN", i - 1, bytes2, result);
        continue;
      }
      let res = c & (1 << 8 - extraLength - 1) - 1;
      for (let j = 0; j < extraLength; j++) {
        let nextChar = bytes2[i];
        if ((nextChar & 192) != 128) {
          i += onError("MISSING_CONTINUE", i, bytes2, result);
          res = null;
          break;
        }
        ;
        res = res << 6 | nextChar & 63;
        i++;
      }
      if (res === null) {
        continue;
      }
      if (res > 1114111) {
        i += onError("OUT_OF_RANGE", i - 1 - extraLength, bytes2, result, res);
        continue;
      }
      if (res >= 55296 && res <= 57343) {
        i += onError("UTF16_SURROGATE", i - 1 - extraLength, bytes2, result, res);
        continue;
      }
      if (res <= overlongMask) {
        i += onError("OVERLONG", i - 1 - extraLength, bytes2, result, res);
        continue;
      }
      result.push(res);
    }
    return result;
  }
  function toUtf8Bytes(str, form) {
    assertArgument(typeof str === "string", "invalid string value", "str", str);
    if (form != null) {
      assertNormalize(form);
      str = str.normalize(form);
    }
    let result = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 128) {
        result.push(c);
      } else if (c < 2048) {
        result.push(c >> 6 | 192);
        result.push(c & 63 | 128);
      } else if ((c & 64512) == 55296) {
        i++;
        const c2 = str.charCodeAt(i);
        assertArgument(i < str.length && (c2 & 64512) === 56320, "invalid surrogate pair", "str", str);
        const pair = 65536 + ((c & 1023) << 10) + (c2 & 1023);
        result.push(pair >> 18 | 240);
        result.push(pair >> 12 & 63 | 128);
        result.push(pair >> 6 & 63 | 128);
        result.push(pair & 63 | 128);
      } else {
        result.push(c >> 12 | 224);
        result.push(c >> 6 & 63 | 128);
        result.push(c & 63 | 128);
      }
    }
    return new Uint8Array(result);
  }
  function _toUtf8String(codePoints) {
    return codePoints.map((codePoint) => {
      if (codePoint <= 65535) {
        return String.fromCharCode(codePoint);
      }
      codePoint -= 65536;
      return String.fromCharCode((codePoint >> 10 & 1023) + 55296, (codePoint & 1023) + 56320);
    }).join("");
  }
  function toUtf8String(bytes2, onError) {
    return _toUtf8String(getUtf8CodePoints(bytes2, onError));
  }

  // node_modules/ethers/lib.esm/abi/coders/abstract-coder.js
  var WordSize = 32;
  var Padding = new Uint8Array(WordSize);
  var passProperties = ["then"];
  var _guard = {};
  var resultNames = /* @__PURE__ */ new WeakMap();
  function getNames(result) {
    return resultNames.get(result);
  }
  function setNames(result, names) {
    resultNames.set(result, names);
  }
  function throwError(name, error) {
    const wrapped = new Error(`deferred error during ABI decoding triggered accessing ${name}`);
    wrapped.error = error;
    throw wrapped;
  }
  function toObject(names, items, deep) {
    if (names.indexOf(null) >= 0) {
      return items.map((item, index) => {
        if (item instanceof Result) {
          return toObject(getNames(item), item, deep);
        }
        return item;
      });
    }
    return names.reduce((accum, name, index) => {
      let item = items.getValue(name);
      if (!(name in accum)) {
        if (deep && item instanceof Result) {
          item = toObject(getNames(item), item, deep);
        }
        accum[name] = item;
      }
      return accum;
    }, {});
  }
  var Result = class _Result extends Array {
    // No longer used; but cannot be removed as it will remove the
    // #private field from the .d.ts which may break backwards
    // compatibility
    #names;
    /**
     *  @private
     */
    constructor(...args) {
      const guard = args[0];
      let items = args[1];
      let names = (args[2] || []).slice();
      let wrap = true;
      if (guard !== _guard) {
        items = args;
        names = [];
        wrap = false;
      }
      super(items.length);
      items.forEach((item, index) => {
        this[index] = item;
      });
      const nameCounts = names.reduce((accum, name) => {
        if (typeof name === "string") {
          accum.set(name, (accum.get(name) || 0) + 1);
        }
        return accum;
      }, /* @__PURE__ */ new Map());
      setNames(this, Object.freeze(items.map((item, index) => {
        const name = names[index];
        if (name != null && nameCounts.get(name) === 1) {
          return name;
        }
        return null;
      })));
      this.#names = [];
      if (this.#names == null) {
        void this.#names;
      }
      if (!wrap) {
        return;
      }
      Object.freeze(this);
      const proxy = new Proxy(this, {
        get: (target, prop, receiver) => {
          if (typeof prop === "string") {
            if (prop.match(/^[0-9]+$/)) {
              const index = getNumber(prop, "%index");
              if (index < 0 || index >= this.length) {
                throw new RangeError("out of result range");
              }
              const item = target[index];
              if (item instanceof Error) {
                throwError(`index ${index}`, item);
              }
              return item;
            }
            if (passProperties.indexOf(prop) >= 0) {
              return Reflect.get(target, prop, receiver);
            }
            const value = target[prop];
            if (value instanceof Function) {
              return function(...args2) {
                return value.apply(this === receiver ? target : this, args2);
              };
            } else if (!(prop in target)) {
              return target.getValue.apply(this === receiver ? target : this, [prop]);
            }
          }
          return Reflect.get(target, prop, receiver);
        }
      });
      setNames(proxy, getNames(this));
      return proxy;
    }
    /**
     *  Returns the Result as a normal Array. If %%deep%%, any children
     *  which are Result objects are also converted to a normal Array.
     *
     *  This will throw if there are any outstanding deferred
     *  errors.
     */
    toArray(deep) {
      const result = [];
      this.forEach((item, index) => {
        if (item instanceof Error) {
          throwError(`index ${index}`, item);
        }
        if (deep && item instanceof _Result) {
          item = item.toArray(deep);
        }
        result.push(item);
      });
      return result;
    }
    /**
     *  Returns the Result as an Object with each name-value pair. If
     *  %%deep%%, any children which are Result objects are also
     *  converted to an Object.
     *
     *  This will throw if any value is unnamed, or if there are
     *  any outstanding deferred errors.
     */
    toObject(deep) {
      const names = getNames(this);
      return names.reduce((accum, name, index) => {
        assert(name != null, `value at index ${index} unnamed`, "UNSUPPORTED_OPERATION", {
          operation: "toObject()"
        });
        return toObject(names, this, deep);
      }, {});
    }
    /**
     *  @_ignore
     */
    slice(start, end) {
      if (start == null) {
        start = 0;
      }
      if (start < 0) {
        start += this.length;
        if (start < 0) {
          start = 0;
        }
      }
      if (end == null) {
        end = this.length;
      }
      if (end < 0) {
        end += this.length;
        if (end < 0) {
          end = 0;
        }
      }
      if (end > this.length) {
        end = this.length;
      }
      const _names = getNames(this);
      const result = [], names = [];
      for (let i = start; i < end; i++) {
        result.push(this[i]);
        names.push(_names[i]);
      }
      return new _Result(_guard, result, names);
    }
    /**
     *  @_ignore
     */
    filter(callback, thisArg) {
      const _names = getNames(this);
      const result = [], names = [];
      for (let i = 0; i < this.length; i++) {
        const item = this[i];
        if (item instanceof Error) {
          throwError(`index ${i}`, item);
        }
        if (callback.call(thisArg, item, i, this)) {
          result.push(item);
          names.push(_names[i]);
        }
      }
      return new _Result(_guard, result, names);
    }
    /**
     *  @_ignore
     */
    map(callback, thisArg) {
      const result = [];
      for (let i = 0; i < this.length; i++) {
        const item = this[i];
        if (item instanceof Error) {
          throwError(`index ${i}`, item);
        }
        result.push(callback.call(thisArg, item, i, this));
      }
      return result;
    }
    /**
     *  Returns the value for %%name%%.
     *
     *  Since it is possible to have a key whose name conflicts with
     *  a method on a [[Result]] or its superclass Array, or any
     *  JavaScript keyword, this ensures all named values are still
     *  accessible by name.
     */
    getValue(name) {
      const index = getNames(this).indexOf(name);
      if (index === -1) {
        return void 0;
      }
      const value = this[index];
      if (value instanceof Error) {
        throwError(`property ${JSON.stringify(name)}`, value.error);
      }
      return value;
    }
    /**
     *  Creates a new [[Result]] for %%items%% with each entry
     *  also accessible by its corresponding name in %%keys%%.
     */
    static fromItems(items, keys) {
      return new _Result(_guard, items, keys);
    }
  };
  function getValue(value) {
    let bytes2 = toBeArray(value);
    assert(bytes2.length <= WordSize, "value out-of-bounds", "BUFFER_OVERRUN", { buffer: bytes2, length: WordSize, offset: bytes2.length });
    if (bytes2.length !== WordSize) {
      bytes2 = getBytesCopy(concat([Padding.slice(bytes2.length % WordSize), bytes2]));
    }
    return bytes2;
  }
  var Coder = class {
    // The coder name:
    //   - address, uint256, tuple, array, etc.
    name;
    // The fully expanded type, including composite types:
    //   - address, uint256, tuple(address,bytes), uint256[3][4][],  etc.
    type;
    // The localName bound in the signature, in this example it is "baz":
    //   - tuple(address foo, uint bar) baz
    localName;
    // Whether this type is dynamic:
    //  - Dynamic: bytes, string, address[], tuple(boolean[]), etc.
    //  - Not Dynamic: address, uint256, boolean[3], tuple(address, uint8)
    dynamic;
    constructor(name, type, localName, dynamic) {
      defineProperties(this, { name, type, localName, dynamic }, {
        name: "string",
        type: "string",
        localName: "string",
        dynamic: "boolean"
      });
    }
    _throwError(message, value) {
      assertArgument(false, message, this.localName, value);
    }
  };
  var Writer = class {
    // An array of WordSize lengthed objects to concatenation
    #data;
    #dataLength;
    constructor() {
      this.#data = [];
      this.#dataLength = 0;
    }
    get data() {
      return concat(this.#data);
    }
    get length() {
      return this.#dataLength;
    }
    #writeData(data) {
      this.#data.push(data);
      this.#dataLength += data.length;
      return data.length;
    }
    appendWriter(writer) {
      return this.#writeData(getBytesCopy(writer.data));
    }
    // Arrayish item; pad on the right to *nearest* WordSize
    writeBytes(value) {
      let bytes2 = getBytesCopy(value);
      const paddingOffset = bytes2.length % WordSize;
      if (paddingOffset) {
        bytes2 = getBytesCopy(concat([bytes2, Padding.slice(paddingOffset)]));
      }
      return this.#writeData(bytes2);
    }
    // Numeric item; pad on the left *to* WordSize
    writeValue(value) {
      return this.#writeData(getValue(value));
    }
    // Inserts a numeric place-holder, returning a callback that can
    // be used to asjust the value later
    writeUpdatableValue() {
      const offset = this.#data.length;
      this.#data.push(Padding);
      this.#dataLength += WordSize;
      return (value) => {
        this.#data[offset] = getValue(value);
      };
    }
  };
  var Reader = class _Reader {
    // Allows incomplete unpadded data to be read; otherwise an error
    // is raised if attempting to overrun the buffer. This is required
    // to deal with an old Solidity bug, in which event data for
    // external (not public thoguh) was tightly packed.
    allowLoose;
    #data;
    #offset;
    #bytesRead;
    #parent;
    #maxInflation;
    constructor(data, allowLoose, maxInflation) {
      defineProperties(this, { allowLoose: !!allowLoose });
      this.#data = getBytesCopy(data);
      this.#bytesRead = 0;
      this.#parent = null;
      this.#maxInflation = maxInflation != null ? maxInflation : 1024;
      this.#offset = 0;
    }
    get data() {
      return hexlify(this.#data);
    }
    get dataLength() {
      return this.#data.length;
    }
    get consumed() {
      return this.#offset;
    }
    get bytes() {
      return new Uint8Array(this.#data);
    }
    #incrementBytesRead(count) {
      if (this.#parent) {
        return this.#parent.#incrementBytesRead(count);
      }
      this.#bytesRead += count;
      assert(this.#maxInflation < 1 || this.#bytesRead <= this.#maxInflation * this.dataLength, `compressed ABI data exceeds inflation ratio of ${this.#maxInflation} ( see: https://github.com/ethers-io/ethers.js/issues/4537 )`, "BUFFER_OVERRUN", {
        buffer: getBytesCopy(this.#data),
        offset: this.#offset,
        length: count,
        info: {
          bytesRead: this.#bytesRead,
          dataLength: this.dataLength
        }
      });
    }
    #peekBytes(offset, length, loose) {
      let alignedLength = Math.ceil(length / WordSize) * WordSize;
      if (this.#offset + alignedLength > this.#data.length) {
        if (this.allowLoose && loose && this.#offset + length <= this.#data.length) {
          alignedLength = length;
        } else {
          assert(false, "data out-of-bounds", "BUFFER_OVERRUN", {
            buffer: getBytesCopy(this.#data),
            length: this.#data.length,
            offset: this.#offset + alignedLength
          });
        }
      }
      return this.#data.slice(this.#offset, this.#offset + alignedLength);
    }
    // Create a sub-reader with the same underlying data, but offset
    subReader(offset) {
      const reader = new _Reader(this.#data.slice(this.#offset + offset), this.allowLoose, this.#maxInflation);
      reader.#parent = this;
      return reader;
    }
    // Read bytes
    readBytes(length, loose) {
      let bytes2 = this.#peekBytes(0, length, !!loose);
      this.#incrementBytesRead(length);
      this.#offset += bytes2.length;
      return bytes2.slice(0, length);
    }
    // Read a numeric values
    readValue() {
      return toBigInt(this.readBytes(WordSize));
    }
    readIndex() {
      return toNumber(this.readBytes(WordSize));
    }
  };

  // node_modules/@noble/hashes/esm/_assert.js
  function number(n2) {
    if (!Number.isSafeInteger(n2) || n2 < 0)
      throw new Error(`Wrong positive integer: ${n2}`);
  }
  function bytes(b2, ...lengths) {
    if (!(b2 instanceof Uint8Array))
      throw new Error("Expected Uint8Array");
    if (lengths.length > 0 && !lengths.includes(b2.length))
      throw new Error(`Expected Uint8Array of length ${lengths}, not of length=${b2.length}`);
  }
  function hash(hash2) {
    if (typeof hash2 !== "function" || typeof hash2.create !== "function")
      throw new Error("Hash should be wrapped by utils.wrapConstructor");
    number(hash2.outputLen);
    number(hash2.blockLen);
  }
  function exists(instance, checkFinished = true) {
    if (instance.destroyed)
      throw new Error("Hash instance has been destroyed");
    if (checkFinished && instance.finished)
      throw new Error("Hash#digest() has already been called");
  }
  function output(out, instance) {
    bytes(out);
    const min = instance.outputLen;
    if (out.length < min) {
      throw new Error(`digestInto() expects output buffer of length at least ${min}`);
    }
  }

  // node_modules/@noble/hashes/esm/crypto.js
  var crypto2 = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;

  // node_modules/@noble/hashes/esm/utils.js
  var u8a = (a) => a instanceof Uint8Array;
  var u32 = (arr) => new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
  var createView = (arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  var rotr = (word, shift) => word << 32 - shift | word >>> shift;
  var isLE = new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68;
  if (!isLE)
    throw new Error("Non little-endian hardware is not supported");
  function utf8ToBytes(str) {
    if (typeof str !== "string")
      throw new Error(`utf8ToBytes expected string, got ${typeof str}`);
    return new Uint8Array(new TextEncoder().encode(str));
  }
  function toBytes(data) {
    if (typeof data === "string")
      data = utf8ToBytes(data);
    if (!u8a(data))
      throw new Error(`expected Uint8Array, got ${typeof data}`);
    return data;
  }
  function concatBytes(...arrays) {
    const r = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
    let pad = 0;
    arrays.forEach((a) => {
      if (!u8a(a))
        throw new Error("Uint8Array expected");
      r.set(a, pad);
      pad += a.length;
    });
    return r;
  }
  var Hash = class {
    // Safe version that clones internal state
    clone() {
      return this._cloneInto();
    }
  };
  var toStr = {}.toString;
  function wrapConstructor(hashCons) {
    const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
    const tmp = hashCons();
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = () => hashCons();
    return hashC;
  }
  function wrapXOFConstructorWithOpts(hashCons) {
    const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
    const tmp = hashCons({});
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = (opts) => hashCons(opts);
    return hashC;
  }
  function randomBytes(bytesLength = 32) {
    if (crypto2 && typeof crypto2.getRandomValues === "function") {
      return crypto2.getRandomValues(new Uint8Array(bytesLength));
    }
    throw new Error("crypto.getRandomValues must be defined");
  }

  // node_modules/@noble/hashes/esm/hmac.js
  var HMAC = class extends Hash {
    constructor(hash2, _key) {
      super();
      this.finished = false;
      this.destroyed = false;
      hash(hash2);
      const key = toBytes(_key);
      this.iHash = hash2.create();
      if (typeof this.iHash.update !== "function")
        throw new Error("Expected instance of class which extends utils.Hash");
      this.blockLen = this.iHash.blockLen;
      this.outputLen = this.iHash.outputLen;
      const blockLen = this.blockLen;
      const pad = new Uint8Array(blockLen);
      pad.set(key.length > blockLen ? hash2.create().update(key).digest() : key);
      for (let i = 0; i < pad.length; i++)
        pad[i] ^= 54;
      this.iHash.update(pad);
      this.oHash = hash2.create();
      for (let i = 0; i < pad.length; i++)
        pad[i] ^= 54 ^ 92;
      this.oHash.update(pad);
      pad.fill(0);
    }
    update(buf) {
      exists(this);
      this.iHash.update(buf);
      return this;
    }
    digestInto(out) {
      exists(this);
      bytes(out, this.outputLen);
      this.finished = true;
      this.iHash.digestInto(out);
      this.oHash.update(out);
      this.oHash.digestInto(out);
      this.destroy();
    }
    digest() {
      const out = new Uint8Array(this.oHash.outputLen);
      this.digestInto(out);
      return out;
    }
    _cloneInto(to) {
      to || (to = Object.create(Object.getPrototypeOf(this), {}));
      const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
      to = to;
      to.finished = finished;
      to.destroyed = destroyed;
      to.blockLen = blockLen;
      to.outputLen = outputLen;
      to.oHash = oHash._cloneInto(to.oHash);
      to.iHash = iHash._cloneInto(to.iHash);
      return to;
    }
    destroy() {
      this.destroyed = true;
      this.oHash.destroy();
      this.iHash.destroy();
    }
  };
  var hmac = (hash2, key, message) => new HMAC(hash2, key).update(message).digest();
  hmac.create = (hash2, key) => new HMAC(hash2, key);

  // node_modules/@noble/hashes/esm/_sha2.js
  function setBigUint64(view, byteOffset, value, isLE3) {
    if (typeof view.setBigUint64 === "function")
      return view.setBigUint64(byteOffset, value, isLE3);
    const _32n3 = BigInt(32);
    const _u32_max = BigInt(4294967295);
    const wh = Number(value >> _32n3 & _u32_max);
    const wl = Number(value & _u32_max);
    const h = isLE3 ? 4 : 0;
    const l = isLE3 ? 0 : 4;
    view.setUint32(byteOffset + h, wh, isLE3);
    view.setUint32(byteOffset + l, wl, isLE3);
  }
  var SHA2 = class extends Hash {
    constructor(blockLen, outputLen, padOffset, isLE3) {
      super();
      this.blockLen = blockLen;
      this.outputLen = outputLen;
      this.padOffset = padOffset;
      this.isLE = isLE3;
      this.finished = false;
      this.length = 0;
      this.pos = 0;
      this.destroyed = false;
      this.buffer = new Uint8Array(blockLen);
      this.view = createView(this.buffer);
    }
    update(data) {
      exists(this);
      const { view, buffer, blockLen } = this;
      data = toBytes(data);
      const len = data.length;
      for (let pos = 0; pos < len; ) {
        const take = Math.min(blockLen - this.pos, len - pos);
        if (take === blockLen) {
          const dataView = createView(data);
          for (; blockLen <= len - pos; pos += blockLen)
            this.process(dataView, pos);
          continue;
        }
        buffer.set(data.subarray(pos, pos + take), this.pos);
        this.pos += take;
        pos += take;
        if (this.pos === blockLen) {
          this.process(view, 0);
          this.pos = 0;
        }
      }
      this.length += data.length;
      this.roundClean();
      return this;
    }
    digestInto(out) {
      exists(this);
      output(out, this);
      this.finished = true;
      const { buffer, view, blockLen, isLE: isLE3 } = this;
      let { pos } = this;
      buffer[pos++] = 128;
      this.buffer.subarray(pos).fill(0);
      if (this.padOffset > blockLen - pos) {
        this.process(view, 0);
        pos = 0;
      }
      for (let i = pos; i < blockLen; i++)
        buffer[i] = 0;
      setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE3);
      this.process(view, 0);
      const oview = createView(out);
      const len = this.outputLen;
      if (len % 4)
        throw new Error("_sha2: outputLen should be aligned to 32bit");
      const outLen = len / 4;
      const state = this.get();
      if (outLen > state.length)
        throw new Error("_sha2: outputLen bigger than state");
      for (let i = 0; i < outLen; i++)
        oview.setUint32(4 * i, state[i], isLE3);
    }
    digest() {
      const { buffer, outputLen } = this;
      this.digestInto(buffer);
      const res = buffer.slice(0, outputLen);
      this.destroy();
      return res;
    }
    _cloneInto(to) {
      to || (to = new this.constructor());
      to.set(...this.get());
      const { blockLen, buffer, length, finished, destroyed, pos } = this;
      to.length = length;
      to.pos = pos;
      to.finished = finished;
      to.destroyed = destroyed;
      if (length % blockLen)
        to.buffer.set(buffer);
      return to;
    }
  };

  // node_modules/@noble/hashes/esm/sha256.js
  var Chi = (a, b2, c) => a & b2 ^ ~a & c;
  var Maj = (a, b2, c) => a & b2 ^ a & c ^ b2 & c;
  var SHA256_K = /* @__PURE__ */ new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  var IV = /* @__PURE__ */ new Uint32Array([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
  var SHA256 = class extends SHA2 {
    constructor() {
      super(64, 32, 8, false);
      this.A = IV[0] | 0;
      this.B = IV[1] | 0;
      this.C = IV[2] | 0;
      this.D = IV[3] | 0;
      this.E = IV[4] | 0;
      this.F = IV[5] | 0;
      this.G = IV[6] | 0;
      this.H = IV[7] | 0;
    }
    get() {
      const { A, B, C, D, E, F, G, H } = this;
      return [A, B, C, D, E, F, G, H];
    }
    // prettier-ignore
    set(A, B, C, D, E, F, G, H) {
      this.A = A | 0;
      this.B = B | 0;
      this.C = C | 0;
      this.D = D | 0;
      this.E = E | 0;
      this.F = F | 0;
      this.G = G | 0;
      this.H = H | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4)
        SHA256_W[i] = view.getUint32(offset, false);
      for (let i = 16; i < 64; i++) {
        const W15 = SHA256_W[i - 15];
        const W2 = SHA256_W[i - 2];
        const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
        const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
        SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
      }
      let { A, B, C, D, E, F, G, H } = this;
      for (let i = 0; i < 64; i++) {
        const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
        const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
        const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
        const T2 = sigma0 + Maj(A, B, C) | 0;
        H = G;
        G = F;
        F = E;
        E = D + T1 | 0;
        D = C;
        C = B;
        B = A;
        A = T1 + T2 | 0;
      }
      A = A + this.A | 0;
      B = B + this.B | 0;
      C = C + this.C | 0;
      D = D + this.D | 0;
      E = E + this.E | 0;
      F = F + this.F | 0;
      G = G + this.G | 0;
      H = H + this.H | 0;
      this.set(A, B, C, D, E, F, G, H);
    }
    roundClean() {
      SHA256_W.fill(0);
    }
    destroy() {
      this.set(0, 0, 0, 0, 0, 0, 0, 0);
      this.buffer.fill(0);
    }
  };
  var sha256 = /* @__PURE__ */ wrapConstructor(() => new SHA256());

  // node_modules/@noble/hashes/esm/_u64.js
  var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
  var _32n = /* @__PURE__ */ BigInt(32);
  function fromBig(n2, le = false) {
    if (le)
      return { h: Number(n2 & U32_MASK64), l: Number(n2 >> _32n & U32_MASK64) };
    return { h: Number(n2 >> _32n & U32_MASK64) | 0, l: Number(n2 & U32_MASK64) | 0 };
  }
  function split(lst, le = false) {
    let Ah = new Uint32Array(lst.length);
    let Al = new Uint32Array(lst.length);
    for (let i = 0; i < lst.length; i++) {
      const { h, l } = fromBig(lst[i], le);
      [Ah[i], Al[i]] = [h, l];
    }
    return [Ah, Al];
  }
  var toBig = (h, l) => BigInt(h >>> 0) << _32n | BigInt(l >>> 0);
  var shrSH = (h, _l, s) => h >>> s;
  var shrSL = (h, l, s) => h << 32 - s | l >>> s;
  var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
  var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
  var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
  var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
  var rotr32H = (_h, l) => l;
  var rotr32L = (h, _l) => h;
  var rotlSH = (h, l, s) => h << s | l >>> 32 - s;
  var rotlSL = (h, l, s) => l << s | h >>> 32 - s;
  var rotlBH = (h, l, s) => l << s - 32 | h >>> 64 - s;
  var rotlBL = (h, l, s) => h << s - 32 | l >>> 64 - s;
  function add(Ah, Al, Bh, Bl) {
    const l = (Al >>> 0) + (Bl >>> 0);
    return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
  }
  var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
  var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
  var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
  var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
  var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
  var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;
  var u64 = {
    fromBig,
    split,
    toBig,
    shrSH,
    shrSL,
    rotrSH,
    rotrSL,
    rotrBH,
    rotrBL,
    rotr32H,
    rotr32L,
    rotlSH,
    rotlSL,
    rotlBH,
    rotlBL,
    add,
    add3L,
    add3H,
    add4L,
    add4H,
    add5H,
    add5L
  };
  var u64_default = u64;

  // node_modules/@noble/hashes/esm/sha512.js
  var [SHA512_Kh, SHA512_Kl] = /* @__PURE__ */ (() => u64_default.split([
    "0x428a2f98d728ae22",
    "0x7137449123ef65cd",
    "0xb5c0fbcfec4d3b2f",
    "0xe9b5dba58189dbbc",
    "0x3956c25bf348b538",
    "0x59f111f1b605d019",
    "0x923f82a4af194f9b",
    "0xab1c5ed5da6d8118",
    "0xd807aa98a3030242",
    "0x12835b0145706fbe",
    "0x243185be4ee4b28c",
    "0x550c7dc3d5ffb4e2",
    "0x72be5d74f27b896f",
    "0x80deb1fe3b1696b1",
    "0x9bdc06a725c71235",
    "0xc19bf174cf692694",
    "0xe49b69c19ef14ad2",
    "0xefbe4786384f25e3",
    "0x0fc19dc68b8cd5b5",
    "0x240ca1cc77ac9c65",
    "0x2de92c6f592b0275",
    "0x4a7484aa6ea6e483",
    "0x5cb0a9dcbd41fbd4",
    "0x76f988da831153b5",
    "0x983e5152ee66dfab",
    "0xa831c66d2db43210",
    "0xb00327c898fb213f",
    "0xbf597fc7beef0ee4",
    "0xc6e00bf33da88fc2",
    "0xd5a79147930aa725",
    "0x06ca6351e003826f",
    "0x142929670a0e6e70",
    "0x27b70a8546d22ffc",
    "0x2e1b21385c26c926",
    "0x4d2c6dfc5ac42aed",
    "0x53380d139d95b3df",
    "0x650a73548baf63de",
    "0x766a0abb3c77b2a8",
    "0x81c2c92e47edaee6",
    "0x92722c851482353b",
    "0xa2bfe8a14cf10364",
    "0xa81a664bbc423001",
    "0xc24b8b70d0f89791",
    "0xc76c51a30654be30",
    "0xd192e819d6ef5218",
    "0xd69906245565a910",
    "0xf40e35855771202a",
    "0x106aa07032bbd1b8",
    "0x19a4c116b8d2d0c8",
    "0x1e376c085141ab53",
    "0x2748774cdf8eeb99",
    "0x34b0bcb5e19b48a8",
    "0x391c0cb3c5c95a63",
    "0x4ed8aa4ae3418acb",
    "0x5b9cca4f7763e373",
    "0x682e6ff3d6b2b8a3",
    "0x748f82ee5defb2fc",
    "0x78a5636f43172f60",
    "0x84c87814a1f0ab72",
    "0x8cc702081a6439ec",
    "0x90befffa23631e28",
    "0xa4506cebde82bde9",
    "0xbef9a3f7b2c67915",
    "0xc67178f2e372532b",
    "0xca273eceea26619c",
    "0xd186b8c721c0c207",
    "0xeada7dd6cde0eb1e",
    "0xf57d4f7fee6ed178",
    "0x06f067aa72176fba",
    "0x0a637dc5a2c898a6",
    "0x113f9804bef90dae",
    "0x1b710b35131c471b",
    "0x28db77f523047d84",
    "0x32caab7b40c72493",
    "0x3c9ebe0a15c9bebc",
    "0x431d67c49c100d4c",
    "0x4cc5d4becb3e42b6",
    "0x597f299cfc657e2a",
    "0x5fcb6fab3ad6faec",
    "0x6c44198c4a475817"
  ].map((n2) => BigInt(n2))))();
  var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
  var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
  var SHA512 = class extends SHA2 {
    constructor() {
      super(128, 64, 16, false);
      this.Ah = 1779033703 | 0;
      this.Al = 4089235720 | 0;
      this.Bh = 3144134277 | 0;
      this.Bl = 2227873595 | 0;
      this.Ch = 1013904242 | 0;
      this.Cl = 4271175723 | 0;
      this.Dh = 2773480762 | 0;
      this.Dl = 1595750129 | 0;
      this.Eh = 1359893119 | 0;
      this.El = 2917565137 | 0;
      this.Fh = 2600822924 | 0;
      this.Fl = 725511199 | 0;
      this.Gh = 528734635 | 0;
      this.Gl = 4215389547 | 0;
      this.Hh = 1541459225 | 0;
      this.Hl = 327033209 | 0;
    }
    // prettier-ignore
    get() {
      const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
    }
    // prettier-ignore
    set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
      this.Ah = Ah | 0;
      this.Al = Al | 0;
      this.Bh = Bh | 0;
      this.Bl = Bl | 0;
      this.Ch = Ch | 0;
      this.Cl = Cl | 0;
      this.Dh = Dh | 0;
      this.Dl = Dl | 0;
      this.Eh = Eh | 0;
      this.El = El | 0;
      this.Fh = Fh | 0;
      this.Fl = Fl | 0;
      this.Gh = Gh | 0;
      this.Gl = Gl | 0;
      this.Hh = Hh | 0;
      this.Hl = Hl | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4) {
        SHA512_W_H[i] = view.getUint32(offset);
        SHA512_W_L[i] = view.getUint32(offset += 4);
      }
      for (let i = 16; i < 80; i++) {
        const W15h = SHA512_W_H[i - 15] | 0;
        const W15l = SHA512_W_L[i - 15] | 0;
        const s0h = u64_default.rotrSH(W15h, W15l, 1) ^ u64_default.rotrSH(W15h, W15l, 8) ^ u64_default.shrSH(W15h, W15l, 7);
        const s0l = u64_default.rotrSL(W15h, W15l, 1) ^ u64_default.rotrSL(W15h, W15l, 8) ^ u64_default.shrSL(W15h, W15l, 7);
        const W2h = SHA512_W_H[i - 2] | 0;
        const W2l = SHA512_W_L[i - 2] | 0;
        const s1h = u64_default.rotrSH(W2h, W2l, 19) ^ u64_default.rotrBH(W2h, W2l, 61) ^ u64_default.shrSH(W2h, W2l, 6);
        const s1l = u64_default.rotrSL(W2h, W2l, 19) ^ u64_default.rotrBL(W2h, W2l, 61) ^ u64_default.shrSL(W2h, W2l, 6);
        const SUMl = u64_default.add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
        const SUMh = u64_default.add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
        SHA512_W_H[i] = SUMh | 0;
        SHA512_W_L[i] = SUMl | 0;
      }
      let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      for (let i = 0; i < 80; i++) {
        const sigma1h = u64_default.rotrSH(Eh, El, 14) ^ u64_default.rotrSH(Eh, El, 18) ^ u64_default.rotrBH(Eh, El, 41);
        const sigma1l = u64_default.rotrSL(Eh, El, 14) ^ u64_default.rotrSL(Eh, El, 18) ^ u64_default.rotrBL(Eh, El, 41);
        const CHIh = Eh & Fh ^ ~Eh & Gh;
        const CHIl = El & Fl ^ ~El & Gl;
        const T1ll = u64_default.add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
        const T1h = u64_default.add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
        const T1l = T1ll | 0;
        const sigma0h = u64_default.rotrSH(Ah, Al, 28) ^ u64_default.rotrBH(Ah, Al, 34) ^ u64_default.rotrBH(Ah, Al, 39);
        const sigma0l = u64_default.rotrSL(Ah, Al, 28) ^ u64_default.rotrBL(Ah, Al, 34) ^ u64_default.rotrBL(Ah, Al, 39);
        const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
        const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
        Hh = Gh | 0;
        Hl = Gl | 0;
        Gh = Fh | 0;
        Gl = Fl | 0;
        Fh = Eh | 0;
        Fl = El | 0;
        ({ h: Eh, l: El } = u64_default.add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
        Dh = Ch | 0;
        Dl = Cl | 0;
        Ch = Bh | 0;
        Cl = Bl | 0;
        Bh = Ah | 0;
        Bl = Al | 0;
        const All = u64_default.add3L(T1l, sigma0l, MAJl);
        Ah = u64_default.add3H(All, T1h, sigma0h, MAJh);
        Al = All | 0;
      }
      ({ h: Ah, l: Al } = u64_default.add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
      ({ h: Bh, l: Bl } = u64_default.add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
      ({ h: Ch, l: Cl } = u64_default.add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
      ({ h: Dh, l: Dl } = u64_default.add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
      ({ h: Eh, l: El } = u64_default.add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
      ({ h: Fh, l: Fl } = u64_default.add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
      ({ h: Gh, l: Gl } = u64_default.add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
      ({ h: Hh, l: Hl } = u64_default.add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
      this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
    }
    roundClean() {
      SHA512_W_H.fill(0);
      SHA512_W_L.fill(0);
    }
    destroy() {
      this.buffer.fill(0);
      this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  };
  var sha512 = /* @__PURE__ */ wrapConstructor(() => new SHA512());

  // node_modules/ethers/lib.esm/crypto/crypto-browser.js
  function getGlobal() {
    if (typeof self !== "undefined") {
      return self;
    }
    if (typeof window !== "undefined") {
      return window;
    }
    if (typeof global !== "undefined") {
      return global;
    }
    throw new Error("unable to locate global object");
  }
  var anyGlobal = getGlobal();
  var crypto3 = anyGlobal.crypto || anyGlobal.msCrypto;
  function createHash(algo) {
    switch (algo) {
      case "sha256":
        return sha256.create();
      case "sha512":
        return sha512.create();
    }
    assertArgument(false, "invalid hashing algorithm name", "algorithm", algo);
  }

  // node_modules/@noble/hashes/esm/sha3.js
  var [SHA3_PI, SHA3_ROTL, _SHA3_IOTA] = [[], [], []];
  var _0n = /* @__PURE__ */ BigInt(0);
  var _1n = /* @__PURE__ */ BigInt(1);
  var _2n = /* @__PURE__ */ BigInt(2);
  var _7n = /* @__PURE__ */ BigInt(7);
  var _256n = /* @__PURE__ */ BigInt(256);
  var _0x71n = /* @__PURE__ */ BigInt(113);
  for (let round = 0, R = _1n, x = 1, y = 0; round < 24; round++) {
    [x, y] = [y, (2 * x + 3 * y) % 5];
    SHA3_PI.push(2 * (5 * y + x));
    SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
    let t = _0n;
    for (let j = 0; j < 7; j++) {
      R = (R << _1n ^ (R >> _7n) * _0x71n) % _256n;
      if (R & _2n)
        t ^= _1n << (_1n << /* @__PURE__ */ BigInt(j)) - _1n;
    }
    _SHA3_IOTA.push(t);
  }
  var [SHA3_IOTA_H, SHA3_IOTA_L] = /* @__PURE__ */ split(_SHA3_IOTA, true);
  var rotlH = (h, l, s) => s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s);
  var rotlL = (h, l, s) => s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s);
  function keccakP(s, rounds = 24) {
    const B = new Uint32Array(5 * 2);
    for (let round = 24 - rounds; round < 24; round++) {
      for (let x = 0; x < 10; x++)
        B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
      for (let x = 0; x < 10; x += 2) {
        const idx1 = (x + 8) % 10;
        const idx0 = (x + 2) % 10;
        const B0 = B[idx0];
        const B1 = B[idx0 + 1];
        const Th = rotlH(B0, B1, 1) ^ B[idx1];
        const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
        for (let y = 0; y < 50; y += 10) {
          s[x + y] ^= Th;
          s[x + y + 1] ^= Tl;
        }
      }
      let curH = s[2];
      let curL = s[3];
      for (let t = 0; t < 24; t++) {
        const shift = SHA3_ROTL[t];
        const Th = rotlH(curH, curL, shift);
        const Tl = rotlL(curH, curL, shift);
        const PI = SHA3_PI[t];
        curH = s[PI];
        curL = s[PI + 1];
        s[PI] = Th;
        s[PI + 1] = Tl;
      }
      for (let y = 0; y < 50; y += 10) {
        for (let x = 0; x < 10; x++)
          B[x] = s[y + x];
        for (let x = 0; x < 10; x++)
          s[y + x] ^= ~B[(x + 2) % 10] & B[(x + 4) % 10];
      }
      s[0] ^= SHA3_IOTA_H[round];
      s[1] ^= SHA3_IOTA_L[round];
    }
    B.fill(0);
  }
  var Keccak = class _Keccak extends Hash {
    // NOTE: we accept arguments in bytes instead of bits here.
    constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
      super();
      this.blockLen = blockLen;
      this.suffix = suffix;
      this.outputLen = outputLen;
      this.enableXOF = enableXOF;
      this.rounds = rounds;
      this.pos = 0;
      this.posOut = 0;
      this.finished = false;
      this.destroyed = false;
      number(outputLen);
      if (0 >= this.blockLen || this.blockLen >= 200)
        throw new Error("Sha3 supports only keccak-f1600 function");
      this.state = new Uint8Array(200);
      this.state32 = u32(this.state);
    }
    keccak() {
      keccakP(this.state32, this.rounds);
      this.posOut = 0;
      this.pos = 0;
    }
    update(data) {
      exists(this);
      const { blockLen, state } = this;
      data = toBytes(data);
      const len = data.length;
      for (let pos = 0; pos < len; ) {
        const take = Math.min(blockLen - this.pos, len - pos);
        for (let i = 0; i < take; i++)
          state[this.pos++] ^= data[pos++];
        if (this.pos === blockLen)
          this.keccak();
      }
      return this;
    }
    finish() {
      if (this.finished)
        return;
      this.finished = true;
      const { state, suffix, pos, blockLen } = this;
      state[pos] ^= suffix;
      if ((suffix & 128) !== 0 && pos === blockLen - 1)
        this.keccak();
      state[blockLen - 1] ^= 128;
      this.keccak();
    }
    writeInto(out) {
      exists(this, false);
      bytes(out);
      this.finish();
      const bufferOut = this.state;
      const { blockLen } = this;
      for (let pos = 0, len = out.length; pos < len; ) {
        if (this.posOut >= blockLen)
          this.keccak();
        const take = Math.min(blockLen - this.posOut, len - pos);
        out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
        this.posOut += take;
        pos += take;
      }
      return out;
    }
    xofInto(out) {
      if (!this.enableXOF)
        throw new Error("XOF is not possible for this instance");
      return this.writeInto(out);
    }
    xof(bytes2) {
      number(bytes2);
      return this.xofInto(new Uint8Array(bytes2));
    }
    digestInto(out) {
      output(out, this);
      if (this.finished)
        throw new Error("digest() was already called");
      this.writeInto(out);
      this.destroy();
      return out;
    }
    digest() {
      return this.digestInto(new Uint8Array(this.outputLen));
    }
    destroy() {
      this.destroyed = true;
      this.state.fill(0);
    }
    _cloneInto(to) {
      const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
      to || (to = new _Keccak(blockLen, suffix, outputLen, enableXOF, rounds));
      to.state32.set(this.state32);
      to.pos = this.pos;
      to.posOut = this.posOut;
      to.finished = this.finished;
      to.rounds = rounds;
      to.suffix = suffix;
      to.outputLen = outputLen;
      to.enableXOF = enableXOF;
      to.destroyed = this.destroyed;
      return to;
    }
  };
  var gen = (suffix, blockLen, outputLen) => wrapConstructor(() => new Keccak(blockLen, suffix, outputLen));
  var sha3_224 = /* @__PURE__ */ gen(6, 144, 224 / 8);
  var sha3_256 = /* @__PURE__ */ gen(6, 136, 256 / 8);
  var sha3_384 = /* @__PURE__ */ gen(6, 104, 384 / 8);
  var sha3_512 = /* @__PURE__ */ gen(6, 72, 512 / 8);
  var keccak_224 = /* @__PURE__ */ gen(1, 144, 224 / 8);
  var keccak_256 = /* @__PURE__ */ gen(1, 136, 256 / 8);
  var keccak_384 = /* @__PURE__ */ gen(1, 104, 384 / 8);
  var keccak_512 = /* @__PURE__ */ gen(1, 72, 512 / 8);
  var genShake = (suffix, blockLen, outputLen) => wrapXOFConstructorWithOpts((opts = {}) => new Keccak(blockLen, suffix, opts.dkLen === void 0 ? outputLen : opts.dkLen, true));
  var shake128 = /* @__PURE__ */ genShake(31, 168, 128 / 8);
  var shake256 = /* @__PURE__ */ genShake(31, 136, 256 / 8);

  // node_modules/ethers/lib.esm/crypto/keccak.js
  var locked = false;
  var _keccak256 = function(data) {
    return keccak_256(data);
  };
  var __keccak256 = _keccak256;
  function keccak256(_data) {
    const data = getBytes(_data, "data");
    return hexlify(__keccak256(data));
  }
  keccak256._ = _keccak256;
  keccak256.lock = function() {
    locked = true;
  };
  keccak256.register = function(func) {
    if (locked) {
      throw new TypeError("keccak256 is locked");
    }
    __keccak256 = func;
  };
  Object.freeze(keccak256);

  // node_modules/ethers/lib.esm/crypto/sha2.js
  var _sha256 = function(data) {
    return createHash("sha256").update(data).digest();
  };
  var _sha512 = function(data) {
    return createHash("sha512").update(data).digest();
  };
  var __sha256 = _sha256;
  var __sha512 = _sha512;
  var locked256 = false;
  var locked512 = false;
  function sha2562(_data) {
    const data = getBytes(_data, "data");
    return hexlify(__sha256(data));
  }
  sha2562._ = _sha256;
  sha2562.lock = function() {
    locked256 = true;
  };
  sha2562.register = function(func) {
    if (locked256) {
      throw new Error("sha256 is locked");
    }
    __sha256 = func;
  };
  Object.freeze(sha2562);
  function sha5122(_data) {
    const data = getBytes(_data, "data");
    return hexlify(__sha512(data));
  }
  sha5122._ = _sha512;
  sha5122.lock = function() {
    locked512 = true;
  };
  sha5122.register = function(func) {
    if (locked512) {
      throw new Error("sha512 is locked");
    }
    __sha512 = func;
  };
  Object.freeze(sha2562);

  // node_modules/@noble/curves/esm/abstract/utils.js
  var utils_exports = {};
  __export(utils_exports, {
    bitGet: () => bitGet,
    bitLen: () => bitLen,
    bitMask: () => bitMask,
    bitSet: () => bitSet,
    bytesToHex: () => bytesToHex,
    bytesToNumberBE: () => bytesToNumberBE,
    bytesToNumberLE: () => bytesToNumberLE,
    concatBytes: () => concatBytes2,
    createHmacDrbg: () => createHmacDrbg,
    ensureBytes: () => ensureBytes,
    equalBytes: () => equalBytes,
    hexToBytes: () => hexToBytes,
    hexToNumber: () => hexToNumber,
    numberToBytesBE: () => numberToBytesBE,
    numberToBytesLE: () => numberToBytesLE,
    numberToHexUnpadded: () => numberToHexUnpadded,
    numberToVarBytesBE: () => numberToVarBytesBE,
    utf8ToBytes: () => utf8ToBytes2,
    validateObject: () => validateObject
  });
  var _0n2 = BigInt(0);
  var _1n2 = BigInt(1);
  var _2n2 = BigInt(2);
  var u8a2 = (a) => a instanceof Uint8Array;
  var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
  function bytesToHex(bytes2) {
    if (!u8a2(bytes2))
      throw new Error("Uint8Array expected");
    let hex = "";
    for (let i = 0; i < bytes2.length; i++) {
      hex += hexes[bytes2[i]];
    }
    return hex;
  }
  function numberToHexUnpadded(num) {
    const hex = num.toString(16);
    return hex.length & 1 ? `0${hex}` : hex;
  }
  function hexToNumber(hex) {
    if (typeof hex !== "string")
      throw new Error("hex string expected, got " + typeof hex);
    return BigInt(hex === "" ? "0" : `0x${hex}`);
  }
  function hexToBytes(hex) {
    if (typeof hex !== "string")
      throw new Error("hex string expected, got " + typeof hex);
    const len = hex.length;
    if (len % 2)
      throw new Error("padded hex string expected, got unpadded hex of length " + len);
    const array = new Uint8Array(len / 2);
    for (let i = 0; i < array.length; i++) {
      const j = i * 2;
      const hexByte = hex.slice(j, j + 2);
      const byte = Number.parseInt(hexByte, 16);
      if (Number.isNaN(byte) || byte < 0)
        throw new Error("Invalid byte sequence");
      array[i] = byte;
    }
    return array;
  }
  function bytesToNumberBE(bytes2) {
    return hexToNumber(bytesToHex(bytes2));
  }
  function bytesToNumberLE(bytes2) {
    if (!u8a2(bytes2))
      throw new Error("Uint8Array expected");
    return hexToNumber(bytesToHex(Uint8Array.from(bytes2).reverse()));
  }
  function numberToBytesBE(n2, len) {
    return hexToBytes(n2.toString(16).padStart(len * 2, "0"));
  }
  function numberToBytesLE(n2, len) {
    return numberToBytesBE(n2, len).reverse();
  }
  function numberToVarBytesBE(n2) {
    return hexToBytes(numberToHexUnpadded(n2));
  }
  function ensureBytes(title, hex, expectedLength) {
    let res;
    if (typeof hex === "string") {
      try {
        res = hexToBytes(hex);
      } catch (e) {
        throw new Error(`${title} must be valid hex string, got "${hex}". Cause: ${e}`);
      }
    } else if (u8a2(hex)) {
      res = Uint8Array.from(hex);
    } else {
      throw new Error(`${title} must be hex string or Uint8Array`);
    }
    const len = res.length;
    if (typeof expectedLength === "number" && len !== expectedLength)
      throw new Error(`${title} expected ${expectedLength} bytes, got ${len}`);
    return res;
  }
  function concatBytes2(...arrays) {
    const r = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
    let pad = 0;
    arrays.forEach((a) => {
      if (!u8a2(a))
        throw new Error("Uint8Array expected");
      r.set(a, pad);
      pad += a.length;
    });
    return r;
  }
  function equalBytes(b1, b2) {
    if (b1.length !== b2.length)
      return false;
    for (let i = 0; i < b1.length; i++)
      if (b1[i] !== b2[i])
        return false;
    return true;
  }
  function utf8ToBytes2(str) {
    if (typeof str !== "string")
      throw new Error(`utf8ToBytes expected string, got ${typeof str}`);
    return new Uint8Array(new TextEncoder().encode(str));
  }
  function bitLen(n2) {
    let len;
    for (len = 0; n2 > _0n2; n2 >>= _1n2, len += 1)
      ;
    return len;
  }
  function bitGet(n2, pos) {
    return n2 >> BigInt(pos) & _1n2;
  }
  var bitSet = (n2, pos, value) => {
    return n2 | (value ? _1n2 : _0n2) << BigInt(pos);
  };
  var bitMask = (n2) => (_2n2 << BigInt(n2 - 1)) - _1n2;
  var u8n = (data) => new Uint8Array(data);
  var u8fr = (arr) => Uint8Array.from(arr);
  function createHmacDrbg(hashLen, qByteLen, hmacFn) {
    if (typeof hashLen !== "number" || hashLen < 2)
      throw new Error("hashLen must be a number");
    if (typeof qByteLen !== "number" || qByteLen < 2)
      throw new Error("qByteLen must be a number");
    if (typeof hmacFn !== "function")
      throw new Error("hmacFn must be a function");
    let v = u8n(hashLen);
    let k = u8n(hashLen);
    let i = 0;
    const reset = () => {
      v.fill(1);
      k.fill(0);
      i = 0;
    };
    const h = (...b2) => hmacFn(k, v, ...b2);
    const reseed = (seed = u8n()) => {
      k = h(u8fr([0]), seed);
      v = h();
      if (seed.length === 0)
        return;
      k = h(u8fr([1]), seed);
      v = h();
    };
    const gen2 = () => {
      if (i++ >= 1e3)
        throw new Error("drbg: tried 1000 values");
      let len = 0;
      const out = [];
      while (len < qByteLen) {
        v = h();
        const sl = v.slice();
        out.push(sl);
        len += v.length;
      }
      return concatBytes2(...out);
    };
    const genUntil = (seed, pred) => {
      reset();
      reseed(seed);
      let res = void 0;
      while (!(res = pred(gen2())))
        reseed();
      reset();
      return res;
    };
    return genUntil;
  }
  var validatorFns = {
    bigint: (val) => typeof val === "bigint",
    function: (val) => typeof val === "function",
    boolean: (val) => typeof val === "boolean",
    string: (val) => typeof val === "string",
    stringOrUint8Array: (val) => typeof val === "string" || val instanceof Uint8Array,
    isSafeInteger: (val) => Number.isSafeInteger(val),
    array: (val) => Array.isArray(val),
    field: (val, object) => object.Fp.isValid(val),
    hash: (val) => typeof val === "function" && Number.isSafeInteger(val.outputLen)
  };
  function validateObject(object, validators, optValidators = {}) {
    const checkField = (fieldName, type, isOptional) => {
      const checkVal = validatorFns[type];
      if (typeof checkVal !== "function")
        throw new Error(`Invalid validator "${type}", expected function`);
      const val = object[fieldName];
      if (isOptional && val === void 0)
        return;
      if (!checkVal(val, object)) {
        throw new Error(`Invalid param ${String(fieldName)}=${val} (${typeof val}), expected ${type}`);
      }
    };
    for (const [fieldName, type] of Object.entries(validators))
      checkField(fieldName, type, false);
    for (const [fieldName, type] of Object.entries(optValidators))
      checkField(fieldName, type, true);
    return object;
  }

  // node_modules/@noble/curves/esm/abstract/modular.js
  var _0n3 = BigInt(0);
  var _1n3 = BigInt(1);
  var _2n3 = BigInt(2);
  var _3n = BigInt(3);
  var _4n = BigInt(4);
  var _5n = BigInt(5);
  var _8n = BigInt(8);
  var _9n = BigInt(9);
  var _16n = BigInt(16);
  function mod(a, b2) {
    const result = a % b2;
    return result >= _0n3 ? result : b2 + result;
  }
  function pow(num, power, modulo) {
    if (modulo <= _0n3 || power < _0n3)
      throw new Error("Expected power/modulo > 0");
    if (modulo === _1n3)
      return _0n3;
    let res = _1n3;
    while (power > _0n3) {
      if (power & _1n3)
        res = res * num % modulo;
      num = num * num % modulo;
      power >>= _1n3;
    }
    return res;
  }
  function pow2(x, power, modulo) {
    let res = x;
    while (power-- > _0n3) {
      res *= res;
      res %= modulo;
    }
    return res;
  }
  function invert(number2, modulo) {
    if (number2 === _0n3 || modulo <= _0n3) {
      throw new Error(`invert: expected positive integers, got n=${number2} mod=${modulo}`);
    }
    let a = mod(number2, modulo);
    let b2 = modulo;
    let x = _0n3, y = _1n3, u = _1n3, v = _0n3;
    while (a !== _0n3) {
      const q = b2 / a;
      const r = b2 % a;
      const m = x - u * q;
      const n2 = y - v * q;
      b2 = a, a = r, x = u, y = v, u = m, v = n2;
    }
    const gcd = b2;
    if (gcd !== _1n3)
      throw new Error("invert: does not exist");
    return mod(x, modulo);
  }
  function tonelliShanks(P) {
    const legendreC = (P - _1n3) / _2n3;
    let Q2, S, Z;
    for (Q2 = P - _1n3, S = 0; Q2 % _2n3 === _0n3; Q2 /= _2n3, S++)
      ;
    for (Z = _2n3; Z < P && pow(Z, legendreC, P) !== P - _1n3; Z++)
      ;
    if (S === 1) {
      const p1div4 = (P + _1n3) / _4n;
      return function tonelliFast(Fp2, n2) {
        const root = Fp2.pow(n2, p1div4);
        if (!Fp2.eql(Fp2.sqr(root), n2))
          throw new Error("Cannot find square root");
        return root;
      };
    }
    const Q1div2 = (Q2 + _1n3) / _2n3;
    return function tonelliSlow(Fp2, n2) {
      if (Fp2.pow(n2, legendreC) === Fp2.neg(Fp2.ONE))
        throw new Error("Cannot find square root");
      let r = S;
      let g = Fp2.pow(Fp2.mul(Fp2.ONE, Z), Q2);
      let x = Fp2.pow(n2, Q1div2);
      let b2 = Fp2.pow(n2, Q2);
      while (!Fp2.eql(b2, Fp2.ONE)) {
        if (Fp2.eql(b2, Fp2.ZERO))
          return Fp2.ZERO;
        let m = 1;
        for (let t2 = Fp2.sqr(b2); m < r; m++) {
          if (Fp2.eql(t2, Fp2.ONE))
            break;
          t2 = Fp2.sqr(t2);
        }
        const ge = Fp2.pow(g, _1n3 << BigInt(r - m - 1));
        g = Fp2.sqr(ge);
        x = Fp2.mul(x, ge);
        b2 = Fp2.mul(b2, g);
        r = m;
      }
      return x;
    };
  }
  function FpSqrt(P) {
    if (P % _4n === _3n) {
      const p1div4 = (P + _1n3) / _4n;
      return function sqrt3mod4(Fp2, n2) {
        const root = Fp2.pow(n2, p1div4);
        if (!Fp2.eql(Fp2.sqr(root), n2))
          throw new Error("Cannot find square root");
        return root;
      };
    }
    if (P % _8n === _5n) {
      const c1 = (P - _5n) / _8n;
      return function sqrt5mod8(Fp2, n2) {
        const n22 = Fp2.mul(n2, _2n3);
        const v = Fp2.pow(n22, c1);
        const nv = Fp2.mul(n2, v);
        const i = Fp2.mul(Fp2.mul(nv, _2n3), v);
        const root = Fp2.mul(nv, Fp2.sub(i, Fp2.ONE));
        if (!Fp2.eql(Fp2.sqr(root), n2))
          throw new Error("Cannot find square root");
        return root;
      };
    }
    if (P % _16n === _9n) {
    }
    return tonelliShanks(P);
  }
  var FIELD_FIELDS = [
    "create",
    "isValid",
    "is0",
    "neg",
    "inv",
    "sqrt",
    "sqr",
    "eql",
    "add",
    "sub",
    "mul",
    "pow",
    "div",
    "addN",
    "subN",
    "mulN",
    "sqrN"
  ];
  function validateField(field) {
    const initial = {
      ORDER: "bigint",
      MASK: "bigint",
      BYTES: "isSafeInteger",
      BITS: "isSafeInteger"
    };
    const opts = FIELD_FIELDS.reduce((map, val) => {
      map[val] = "function";
      return map;
    }, initial);
    return validateObject(field, opts);
  }
  function FpPow(f, num, power) {
    if (power < _0n3)
      throw new Error("Expected power > 0");
    if (power === _0n3)
      return f.ONE;
    if (power === _1n3)
      return num;
    let p = f.ONE;
    let d = num;
    while (power > _0n3) {
      if (power & _1n3)
        p = f.mul(p, d);
      d = f.sqr(d);
      power >>= _1n3;
    }
    return p;
  }
  function FpInvertBatch(f, nums) {
    const tmp = new Array(nums.length);
    const lastMultiplied = nums.reduce((acc, num, i) => {
      if (f.is0(num))
        return acc;
      tmp[i] = acc;
      return f.mul(acc, num);
    }, f.ONE);
    const inverted = f.inv(lastMultiplied);
    nums.reduceRight((acc, num, i) => {
      if (f.is0(num))
        return acc;
      tmp[i] = f.mul(acc, tmp[i]);
      return f.mul(acc, num);
    }, inverted);
    return tmp;
  }
  function nLength(n2, nBitLength) {
    const _nBitLength = nBitLength !== void 0 ? nBitLength : n2.toString(2).length;
    const nByteLength = Math.ceil(_nBitLength / 8);
    return { nBitLength: _nBitLength, nByteLength };
  }
  function Field(ORDER, bitLen2, isLE3 = false, redef = {}) {
    if (ORDER <= _0n3)
      throw new Error(`Expected Field ORDER > 0, got ${ORDER}`);
    const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, bitLen2);
    if (BYTES > 2048)
      throw new Error("Field lengths over 2048 bytes are not supported");
    const sqrtP = FpSqrt(ORDER);
    const f = Object.freeze({
      ORDER,
      BITS,
      BYTES,
      MASK: bitMask(BITS),
      ZERO: _0n3,
      ONE: _1n3,
      create: (num) => mod(num, ORDER),
      isValid: (num) => {
        if (typeof num !== "bigint")
          throw new Error(`Invalid field element: expected bigint, got ${typeof num}`);
        return _0n3 <= num && num < ORDER;
      },
      is0: (num) => num === _0n3,
      isOdd: (num) => (num & _1n3) === _1n3,
      neg: (num) => mod(-num, ORDER),
      eql: (lhs, rhs) => lhs === rhs,
      sqr: (num) => mod(num * num, ORDER),
      add: (lhs, rhs) => mod(lhs + rhs, ORDER),
      sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
      mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
      pow: (num, power) => FpPow(f, num, power),
      div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
      // Same as above, but doesn't normalize
      sqrN: (num) => num * num,
      addN: (lhs, rhs) => lhs + rhs,
      subN: (lhs, rhs) => lhs - rhs,
      mulN: (lhs, rhs) => lhs * rhs,
      inv: (num) => invert(num, ORDER),
      sqrt: redef.sqrt || ((n2) => sqrtP(f, n2)),
      invertBatch: (lst) => FpInvertBatch(f, lst),
      // TODO: do we really need constant cmov?
      // We don't have const-time bigints anyway, so probably will be not very useful
      cmov: (a, b2, c) => c ? b2 : a,
      toBytes: (num) => isLE3 ? numberToBytesLE(num, BYTES) : numberToBytesBE(num, BYTES),
      fromBytes: (bytes2) => {
        if (bytes2.length !== BYTES)
          throw new Error(`Fp.fromBytes: expected ${BYTES}, got ${bytes2.length}`);
        return isLE3 ? bytesToNumberLE(bytes2) : bytesToNumberBE(bytes2);
      }
    });
    return Object.freeze(f);
  }
  function getFieldBytesLength(fieldOrder) {
    if (typeof fieldOrder !== "bigint")
      throw new Error("field order must be bigint");
    const bitLength = fieldOrder.toString(2).length;
    return Math.ceil(bitLength / 8);
  }
  function getMinHashLength(fieldOrder) {
    const length = getFieldBytesLength(fieldOrder);
    return length + Math.ceil(length / 2);
  }
  function mapHashToField(key, fieldOrder, isLE3 = false) {
    const len = key.length;
    const fieldLen = getFieldBytesLength(fieldOrder);
    const minLen = getMinHashLength(fieldOrder);
    if (len < 16 || len < minLen || len > 1024)
      throw new Error(`expected ${minLen}-1024 bytes of input, got ${len}`);
    const num = isLE3 ? bytesToNumberBE(key) : bytesToNumberLE(key);
    const reduced = mod(num, fieldOrder - _1n3) + _1n3;
    return isLE3 ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
  }

  // node_modules/@noble/curves/esm/abstract/curve.js
  var _0n4 = BigInt(0);
  var _1n4 = BigInt(1);
  function wNAF(c, bits) {
    const constTimeNegate = (condition, item) => {
      const neg = item.negate();
      return condition ? neg : item;
    };
    const opts = (W) => {
      const windows = Math.ceil(bits / W) + 1;
      const windowSize = 2 ** (W - 1);
      return { windows, windowSize };
    };
    return {
      constTimeNegate,
      // non-const time multiplication ladder
      unsafeLadder(elm, n2) {
        let p = c.ZERO;
        let d = elm;
        while (n2 > _0n4) {
          if (n2 & _1n4)
            p = p.add(d);
          d = d.double();
          n2 >>= _1n4;
        }
        return p;
      },
      /**
       * Creates a wNAF precomputation window. Used for caching.
       * Default window size is set by `utils.precompute()` and is equal to 8.
       * Number of precomputed points depends on the curve size:
       * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
       * - 𝑊 is the window size
       * - 𝑛 is the bitlength of the curve order.
       * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
       * @returns precomputed point tables flattened to a single array
       */
      precomputeWindow(elm, W) {
        const { windows, windowSize } = opts(W);
        const points = [];
        let p = elm;
        let base = p;
        for (let window2 = 0; window2 < windows; window2++) {
          base = p;
          points.push(base);
          for (let i = 1; i < windowSize; i++) {
            base = base.add(p);
            points.push(base);
          }
          p = base.double();
        }
        return points;
      },
      /**
       * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
       * @param W window size
       * @param precomputes precomputed tables
       * @param n scalar (we don't check here, but should be less than curve order)
       * @returns real and fake (for const-time) points
       */
      wNAF(W, precomputes, n2) {
        const { windows, windowSize } = opts(W);
        let p = c.ZERO;
        let f = c.BASE;
        const mask2 = BigInt(2 ** W - 1);
        const maxNumber = 2 ** W;
        const shiftBy = BigInt(W);
        for (let window2 = 0; window2 < windows; window2++) {
          const offset = window2 * windowSize;
          let wbits = Number(n2 & mask2);
          n2 >>= shiftBy;
          if (wbits > windowSize) {
            wbits -= maxNumber;
            n2 += _1n4;
          }
          const offset1 = offset;
          const offset2 = offset + Math.abs(wbits) - 1;
          const cond1 = window2 % 2 !== 0;
          const cond2 = wbits < 0;
          if (wbits === 0) {
            f = f.add(constTimeNegate(cond1, precomputes[offset1]));
          } else {
            p = p.add(constTimeNegate(cond2, precomputes[offset2]));
          }
        }
        return { p, f };
      },
      wNAFCached(P, precomputesMap, n2, transform) {
        const W = P._WINDOW_SIZE || 1;
        let comp = precomputesMap.get(P);
        if (!comp) {
          comp = this.precomputeWindow(P, W);
          if (W !== 1) {
            precomputesMap.set(P, transform(comp));
          }
        }
        return this.wNAF(W, comp, n2);
      }
    };
  }
  function validateBasic(curve) {
    validateField(curve.Fp);
    validateObject(curve, {
      n: "bigint",
      h: "bigint",
      Gx: "field",
      Gy: "field"
    }, {
      nBitLength: "isSafeInteger",
      nByteLength: "isSafeInteger"
    });
    return Object.freeze({
      ...nLength(curve.n, curve.nBitLength),
      ...curve,
      ...{ p: curve.Fp.ORDER }
    });
  }

  // node_modules/@noble/curves/esm/abstract/weierstrass.js
  function validatePointOpts(curve) {
    const opts = validateBasic(curve);
    validateObject(opts, {
      a: "field",
      b: "field"
    }, {
      allowedPrivateKeyLengths: "array",
      wrapPrivateKey: "boolean",
      isTorsionFree: "function",
      clearCofactor: "function",
      allowInfinityPoint: "boolean",
      fromBytes: "function",
      toBytes: "function"
    });
    const { endo, Fp: Fp2, a } = opts;
    if (endo) {
      if (!Fp2.eql(a, Fp2.ZERO)) {
        throw new Error("Endomorphism can only be defined for Koblitz curves that have a=0");
      }
      if (typeof endo !== "object" || typeof endo.beta !== "bigint" || typeof endo.splitScalar !== "function") {
        throw new Error("Expected endomorphism with beta: bigint and splitScalar: function");
      }
    }
    return Object.freeze({ ...opts });
  }
  var { bytesToNumberBE: b2n, hexToBytes: h2b } = utils_exports;
  var DER = {
    // asn.1 DER encoding utils
    Err: class DERErr extends Error {
      constructor(m = "") {
        super(m);
      }
    },
    _parseInt(data) {
      const { Err: E } = DER;
      if (data.length < 2 || data[0] !== 2)
        throw new E("Invalid signature integer tag");
      const len = data[1];
      const res = data.subarray(2, len + 2);
      if (!len || res.length !== len)
        throw new E("Invalid signature integer: wrong length");
      if (res[0] & 128)
        throw new E("Invalid signature integer: negative");
      if (res[0] === 0 && !(res[1] & 128))
        throw new E("Invalid signature integer: unnecessary leading zero");
      return { d: b2n(res), l: data.subarray(len + 2) };
    },
    toSig(hex) {
      const { Err: E } = DER;
      const data = typeof hex === "string" ? h2b(hex) : hex;
      if (!(data instanceof Uint8Array))
        throw new Error("ui8a expected");
      let l = data.length;
      if (l < 2 || data[0] != 48)
        throw new E("Invalid signature tag");
      if (data[1] !== l - 2)
        throw new E("Invalid signature: incorrect length");
      const { d: r, l: sBytes } = DER._parseInt(data.subarray(2));
      const { d: s, l: rBytesLeft } = DER._parseInt(sBytes);
      if (rBytesLeft.length)
        throw new E("Invalid signature: left bytes after parsing");
      return { r, s };
    },
    hexFromSig(sig) {
      const slice = (s2) => Number.parseInt(s2[0], 16) & 8 ? "00" + s2 : s2;
      const h = (num) => {
        const hex = num.toString(16);
        return hex.length & 1 ? `0${hex}` : hex;
      };
      const s = slice(h(sig.s));
      const r = slice(h(sig.r));
      const shl = s.length / 2;
      const rhl = r.length / 2;
      const sl = h(shl);
      const rl = h(rhl);
      return `30${h(rhl + shl + 4)}02${rl}${r}02${sl}${s}`;
    }
  };
  var _0n5 = BigInt(0);
  var _1n5 = BigInt(1);
  var _2n4 = BigInt(2);
  var _3n2 = BigInt(3);
  var _4n2 = BigInt(4);
  function weierstrassPoints(opts) {
    const CURVE = validatePointOpts(opts);
    const { Fp: Fp2 } = CURVE;
    const toBytes2 = CURVE.toBytes || ((_c, point, _isCompressed) => {
      const a = point.toAffine();
      return concatBytes2(Uint8Array.from([4]), Fp2.toBytes(a.x), Fp2.toBytes(a.y));
    });
    const fromBytes = CURVE.fromBytes || ((bytes2) => {
      const tail = bytes2.subarray(1);
      const x = Fp2.fromBytes(tail.subarray(0, Fp2.BYTES));
      const y = Fp2.fromBytes(tail.subarray(Fp2.BYTES, 2 * Fp2.BYTES));
      return { x, y };
    });
    function weierstrassEquation(x) {
      const { a, b: b2 } = CURVE;
      const x2 = Fp2.sqr(x);
      const x3 = Fp2.mul(x2, x);
      return Fp2.add(Fp2.add(x3, Fp2.mul(x, a)), b2);
    }
    if (!Fp2.eql(Fp2.sqr(CURVE.Gy), weierstrassEquation(CURVE.Gx)))
      throw new Error("bad generator point: equation left != right");
    function isWithinCurveOrder(num) {
      return typeof num === "bigint" && _0n5 < num && num < CURVE.n;
    }
    function assertGE(num) {
      if (!isWithinCurveOrder(num))
        throw new Error("Expected valid bigint: 0 < bigint < curve.n");
    }
    function normPrivateKeyToScalar(key) {
      const { allowedPrivateKeyLengths: lengths, nByteLength, wrapPrivateKey, n: n2 } = CURVE;
      if (lengths && typeof key !== "bigint") {
        if (key instanceof Uint8Array)
          key = bytesToHex(key);
        if (typeof key !== "string" || !lengths.includes(key.length))
          throw new Error("Invalid key");
        key = key.padStart(nByteLength * 2, "0");
      }
      let num;
      try {
        num = typeof key === "bigint" ? key : bytesToNumberBE(ensureBytes("private key", key, nByteLength));
      } catch (error) {
        throw new Error(`private key must be ${nByteLength} bytes, hex or bigint, not ${typeof key}`);
      }
      if (wrapPrivateKey)
        num = mod(num, n2);
      assertGE(num);
      return num;
    }
    const pointPrecomputes = /* @__PURE__ */ new Map();
    function assertPrjPoint(other) {
      if (!(other instanceof Point2))
        throw new Error("ProjectivePoint expected");
    }
    class Point2 {
      constructor(px, py, pz) {
        this.px = px;
        this.py = py;
        this.pz = pz;
        if (px == null || !Fp2.isValid(px))
          throw new Error("x required");
        if (py == null || !Fp2.isValid(py))
          throw new Error("y required");
        if (pz == null || !Fp2.isValid(pz))
          throw new Error("z required");
      }
      // Does not validate if the point is on-curve.
      // Use fromHex instead, or call assertValidity() later.
      static fromAffine(p) {
        const { x, y } = p || {};
        if (!p || !Fp2.isValid(x) || !Fp2.isValid(y))
          throw new Error("invalid affine point");
        if (p instanceof Point2)
          throw new Error("projective point not allowed");
        const is0 = (i) => Fp2.eql(i, Fp2.ZERO);
        if (is0(x) && is0(y))
          return Point2.ZERO;
        return new Point2(x, y, Fp2.ONE);
      }
      get x() {
        return this.toAffine().x;
      }
      get y() {
        return this.toAffine().y;
      }
      /**
       * Takes a bunch of Projective Points but executes only one
       * inversion on all of them. Inversion is very slow operation,
       * so this improves performance massively.
       * Optimization: converts a list of projective points to a list of identical points with Z=1.
       */
      static normalizeZ(points) {
        const toInv = Fp2.invertBatch(points.map((p) => p.pz));
        return points.map((p, i) => p.toAffine(toInv[i])).map(Point2.fromAffine);
      }
      /**
       * Converts hash string or Uint8Array to Point.
       * @param hex short/long ECDSA hex
       */
      static fromHex(hex) {
        const P = Point2.fromAffine(fromBytes(ensureBytes("pointHex", hex)));
        P.assertValidity();
        return P;
      }
      // Multiplies generator point by privateKey.
      static fromPrivateKey(privateKey) {
        return Point2.BASE.multiply(normPrivateKeyToScalar(privateKey));
      }
      // "Private method", don't use it directly
      _setWindowSize(windowSize) {
        this._WINDOW_SIZE = windowSize;
        pointPrecomputes.delete(this);
      }
      // A point on curve is valid if it conforms to equation.
      assertValidity() {
        if (this.is0()) {
          if (CURVE.allowInfinityPoint && !Fp2.is0(this.py))
            return;
          throw new Error("bad point: ZERO");
        }
        const { x, y } = this.toAffine();
        if (!Fp2.isValid(x) || !Fp2.isValid(y))
          throw new Error("bad point: x or y not FE");
        const left = Fp2.sqr(y);
        const right = weierstrassEquation(x);
        if (!Fp2.eql(left, right))
          throw new Error("bad point: equation left != right");
        if (!this.isTorsionFree())
          throw new Error("bad point: not in prime-order subgroup");
      }
      hasEvenY() {
        const { y } = this.toAffine();
        if (Fp2.isOdd)
          return !Fp2.isOdd(y);
        throw new Error("Field doesn't support isOdd");
      }
      /**
       * Compare one point to another.
       */
      equals(other) {
        assertPrjPoint(other);
        const { px: X1, py: Y1, pz: Z1 } = this;
        const { px: X2, py: Y2, pz: Z2 } = other;
        const U1 = Fp2.eql(Fp2.mul(X1, Z2), Fp2.mul(X2, Z1));
        const U2 = Fp2.eql(Fp2.mul(Y1, Z2), Fp2.mul(Y2, Z1));
        return U1 && U2;
      }
      /**
       * Flips point to one corresponding to (x, -y) in Affine coordinates.
       */
      negate() {
        return new Point2(this.px, Fp2.neg(this.py), this.pz);
      }
      // Renes-Costello-Batina exception-free doubling formula.
      // There is 30% faster Jacobian formula, but it is not complete.
      // https://eprint.iacr.org/2015/1060, algorithm 3
      // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
      double() {
        const { a, b: b2 } = CURVE;
        const b3 = Fp2.mul(b2, _3n2);
        const { px: X1, py: Y1, pz: Z1 } = this;
        let X3 = Fp2.ZERO, Y3 = Fp2.ZERO, Z3 = Fp2.ZERO;
        let t0 = Fp2.mul(X1, X1);
        let t1 = Fp2.mul(Y1, Y1);
        let t2 = Fp2.mul(Z1, Z1);
        let t3 = Fp2.mul(X1, Y1);
        t3 = Fp2.add(t3, t3);
        Z3 = Fp2.mul(X1, Z1);
        Z3 = Fp2.add(Z3, Z3);
        X3 = Fp2.mul(a, Z3);
        Y3 = Fp2.mul(b3, t2);
        Y3 = Fp2.add(X3, Y3);
        X3 = Fp2.sub(t1, Y3);
        Y3 = Fp2.add(t1, Y3);
        Y3 = Fp2.mul(X3, Y3);
        X3 = Fp2.mul(t3, X3);
        Z3 = Fp2.mul(b3, Z3);
        t2 = Fp2.mul(a, t2);
        t3 = Fp2.sub(t0, t2);
        t3 = Fp2.mul(a, t3);
        t3 = Fp2.add(t3, Z3);
        Z3 = Fp2.add(t0, t0);
        t0 = Fp2.add(Z3, t0);
        t0 = Fp2.add(t0, t2);
        t0 = Fp2.mul(t0, t3);
        Y3 = Fp2.add(Y3, t0);
        t2 = Fp2.mul(Y1, Z1);
        t2 = Fp2.add(t2, t2);
        t0 = Fp2.mul(t2, t3);
        X3 = Fp2.sub(X3, t0);
        Z3 = Fp2.mul(t2, t1);
        Z3 = Fp2.add(Z3, Z3);
        Z3 = Fp2.add(Z3, Z3);
        return new Point2(X3, Y3, Z3);
      }
      // Renes-Costello-Batina exception-free addition formula.
      // There is 30% faster Jacobian formula, but it is not complete.
      // https://eprint.iacr.org/2015/1060, algorithm 1
      // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
      add(other) {
        assertPrjPoint(other);
        const { px: X1, py: Y1, pz: Z1 } = this;
        const { px: X2, py: Y2, pz: Z2 } = other;
        let X3 = Fp2.ZERO, Y3 = Fp2.ZERO, Z3 = Fp2.ZERO;
        const a = CURVE.a;
        const b3 = Fp2.mul(CURVE.b, _3n2);
        let t0 = Fp2.mul(X1, X2);
        let t1 = Fp2.mul(Y1, Y2);
        let t2 = Fp2.mul(Z1, Z2);
        let t3 = Fp2.add(X1, Y1);
        let t4 = Fp2.add(X2, Y2);
        t3 = Fp2.mul(t3, t4);
        t4 = Fp2.add(t0, t1);
        t3 = Fp2.sub(t3, t4);
        t4 = Fp2.add(X1, Z1);
        let t5 = Fp2.add(X2, Z2);
        t4 = Fp2.mul(t4, t5);
        t5 = Fp2.add(t0, t2);
        t4 = Fp2.sub(t4, t5);
        t5 = Fp2.add(Y1, Z1);
        X3 = Fp2.add(Y2, Z2);
        t5 = Fp2.mul(t5, X3);
        X3 = Fp2.add(t1, t2);
        t5 = Fp2.sub(t5, X3);
        Z3 = Fp2.mul(a, t4);
        X3 = Fp2.mul(b3, t2);
        Z3 = Fp2.add(X3, Z3);
        X3 = Fp2.sub(t1, Z3);
        Z3 = Fp2.add(t1, Z3);
        Y3 = Fp2.mul(X3, Z3);
        t1 = Fp2.add(t0, t0);
        t1 = Fp2.add(t1, t0);
        t2 = Fp2.mul(a, t2);
        t4 = Fp2.mul(b3, t4);
        t1 = Fp2.add(t1, t2);
        t2 = Fp2.sub(t0, t2);
        t2 = Fp2.mul(a, t2);
        t4 = Fp2.add(t4, t2);
        t0 = Fp2.mul(t1, t4);
        Y3 = Fp2.add(Y3, t0);
        t0 = Fp2.mul(t5, t4);
        X3 = Fp2.mul(t3, X3);
        X3 = Fp2.sub(X3, t0);
        t0 = Fp2.mul(t3, t1);
        Z3 = Fp2.mul(t5, Z3);
        Z3 = Fp2.add(Z3, t0);
        return new Point2(X3, Y3, Z3);
      }
      subtract(other) {
        return this.add(other.negate());
      }
      is0() {
        return this.equals(Point2.ZERO);
      }
      wNAF(n2) {
        return wnaf.wNAFCached(this, pointPrecomputes, n2, (comp) => {
          const toInv = Fp2.invertBatch(comp.map((p) => p.pz));
          return comp.map((p, i) => p.toAffine(toInv[i])).map(Point2.fromAffine);
        });
      }
      /**
       * Non-constant-time multiplication. Uses double-and-add algorithm.
       * It's faster, but should only be used when you don't care about
       * an exposed private key e.g. sig verification, which works over *public* keys.
       */
      multiplyUnsafe(n2) {
        const I = Point2.ZERO;
        if (n2 === _0n5)
          return I;
        assertGE(n2);
        if (n2 === _1n5)
          return this;
        const { endo } = CURVE;
        if (!endo)
          return wnaf.unsafeLadder(this, n2);
        let { k1neg, k1, k2neg, k2 } = endo.splitScalar(n2);
        let k1p = I;
        let k2p = I;
        let d = this;
        while (k1 > _0n5 || k2 > _0n5) {
          if (k1 & _1n5)
            k1p = k1p.add(d);
          if (k2 & _1n5)
            k2p = k2p.add(d);
          d = d.double();
          k1 >>= _1n5;
          k2 >>= _1n5;
        }
        if (k1neg)
          k1p = k1p.negate();
        if (k2neg)
          k2p = k2p.negate();
        k2p = new Point2(Fp2.mul(k2p.px, endo.beta), k2p.py, k2p.pz);
        return k1p.add(k2p);
      }
      /**
       * Constant time multiplication.
       * Uses wNAF method. Windowed method may be 10% faster,
       * but takes 2x longer to generate and consumes 2x memory.
       * Uses precomputes when available.
       * Uses endomorphism for Koblitz curves.
       * @param scalar by which the point would be multiplied
       * @returns New point
       */
      multiply(scalar) {
        assertGE(scalar);
        let n2 = scalar;
        let point, fake;
        const { endo } = CURVE;
        if (endo) {
          const { k1neg, k1, k2neg, k2 } = endo.splitScalar(n2);
          let { p: k1p, f: f1p } = this.wNAF(k1);
          let { p: k2p, f: f2p } = this.wNAF(k2);
          k1p = wnaf.constTimeNegate(k1neg, k1p);
          k2p = wnaf.constTimeNegate(k2neg, k2p);
          k2p = new Point2(Fp2.mul(k2p.px, endo.beta), k2p.py, k2p.pz);
          point = k1p.add(k2p);
          fake = f1p.add(f2p);
        } else {
          const { p, f } = this.wNAF(n2);
          point = p;
          fake = f;
        }
        return Point2.normalizeZ([point, fake])[0];
      }
      /**
       * Efficiently calculate `aP + bQ`. Unsafe, can expose private key, if used incorrectly.
       * Not using Strauss-Shamir trick: precomputation tables are faster.
       * The trick could be useful if both P and Q are not G (not in our case).
       * @returns non-zero affine point
       */
      multiplyAndAddUnsafe(Q2, a, b2) {
        const G = Point2.BASE;
        const mul = (P, a2) => a2 === _0n5 || a2 === _1n5 || !P.equals(G) ? P.multiplyUnsafe(a2) : P.multiply(a2);
        const sum = mul(this, a).add(mul(Q2, b2));
        return sum.is0() ? void 0 : sum;
      }
      // Converts Projective point to affine (x, y) coordinates.
      // Can accept precomputed Z^-1 - for example, from invertBatch.
      // (x, y, z) ∋ (x=x/z, y=y/z)
      toAffine(iz) {
        const { px: x, py: y, pz: z } = this;
        const is0 = this.is0();
        if (iz == null)
          iz = is0 ? Fp2.ONE : Fp2.inv(z);
        const ax = Fp2.mul(x, iz);
        const ay = Fp2.mul(y, iz);
        const zz = Fp2.mul(z, iz);
        if (is0)
          return { x: Fp2.ZERO, y: Fp2.ZERO };
        if (!Fp2.eql(zz, Fp2.ONE))
          throw new Error("invZ was invalid");
        return { x: ax, y: ay };
      }
      isTorsionFree() {
        const { h: cofactor, isTorsionFree } = CURVE;
        if (cofactor === _1n5)
          return true;
        if (isTorsionFree)
          return isTorsionFree(Point2, this);
        throw new Error("isTorsionFree() has not been declared for the elliptic curve");
      }
      clearCofactor() {
        const { h: cofactor, clearCofactor } = CURVE;
        if (cofactor === _1n5)
          return this;
        if (clearCofactor)
          return clearCofactor(Point2, this);
        return this.multiplyUnsafe(CURVE.h);
      }
      toRawBytes(isCompressed = true) {
        this.assertValidity();
        return toBytes2(Point2, this, isCompressed);
      }
      toHex(isCompressed = true) {
        return bytesToHex(this.toRawBytes(isCompressed));
      }
    }
    Point2.BASE = new Point2(CURVE.Gx, CURVE.Gy, Fp2.ONE);
    Point2.ZERO = new Point2(Fp2.ZERO, Fp2.ONE, Fp2.ZERO);
    const _bits = CURVE.nBitLength;
    const wnaf = wNAF(Point2, CURVE.endo ? Math.ceil(_bits / 2) : _bits);
    return {
      CURVE,
      ProjectivePoint: Point2,
      normPrivateKeyToScalar,
      weierstrassEquation,
      isWithinCurveOrder
    };
  }
  function validateOpts(curve) {
    const opts = validateBasic(curve);
    validateObject(opts, {
      hash: "hash",
      hmac: "function",
      randomBytes: "function"
    }, {
      bits2int: "function",
      bits2int_modN: "function",
      lowS: "boolean"
    });
    return Object.freeze({ lowS: true, ...opts });
  }
  function weierstrass(curveDef) {
    const CURVE = validateOpts(curveDef);
    const { Fp: Fp2, n: CURVE_ORDER } = CURVE;
    const compressedLen = Fp2.BYTES + 1;
    const uncompressedLen = 2 * Fp2.BYTES + 1;
    function isValidFieldElement(num) {
      return _0n5 < num && num < Fp2.ORDER;
    }
    function modN(a) {
      return mod(a, CURVE_ORDER);
    }
    function invN(a) {
      return invert(a, CURVE_ORDER);
    }
    const { ProjectivePoint: Point2, normPrivateKeyToScalar, weierstrassEquation, isWithinCurveOrder } = weierstrassPoints({
      ...CURVE,
      toBytes(_c, point, isCompressed) {
        const a = point.toAffine();
        const x = Fp2.toBytes(a.x);
        const cat = concatBytes2;
        if (isCompressed) {
          return cat(Uint8Array.from([point.hasEvenY() ? 2 : 3]), x);
        } else {
          return cat(Uint8Array.from([4]), x, Fp2.toBytes(a.y));
        }
      },
      fromBytes(bytes2) {
        const len = bytes2.length;
        const head = bytes2[0];
        const tail = bytes2.subarray(1);
        if (len === compressedLen && (head === 2 || head === 3)) {
          const x = bytesToNumberBE(tail);
          if (!isValidFieldElement(x))
            throw new Error("Point is not on curve");
          const y2 = weierstrassEquation(x);
          let y = Fp2.sqrt(y2);
          const isYOdd = (y & _1n5) === _1n5;
          const isHeadOdd = (head & 1) === 1;
          if (isHeadOdd !== isYOdd)
            y = Fp2.neg(y);
          return { x, y };
        } else if (len === uncompressedLen && head === 4) {
          const x = Fp2.fromBytes(tail.subarray(0, Fp2.BYTES));
          const y = Fp2.fromBytes(tail.subarray(Fp2.BYTES, 2 * Fp2.BYTES));
          return { x, y };
        } else {
          throw new Error(`Point of length ${len} was invalid. Expected ${compressedLen} compressed bytes or ${uncompressedLen} uncompressed bytes`);
        }
      }
    });
    const numToNByteStr = (num) => bytesToHex(numberToBytesBE(num, CURVE.nByteLength));
    function isBiggerThanHalfOrder(number2) {
      const HALF = CURVE_ORDER >> _1n5;
      return number2 > HALF;
    }
    function normalizeS(s) {
      return isBiggerThanHalfOrder(s) ? modN(-s) : s;
    }
    const slcNum = (b2, from, to) => bytesToNumberBE(b2.slice(from, to));
    class Signature2 {
      constructor(r, s, recovery) {
        this.r = r;
        this.s = s;
        this.recovery = recovery;
        this.assertValidity();
      }
      // pair (bytes of r, bytes of s)
      static fromCompact(hex) {
        const l = CURVE.nByteLength;
        hex = ensureBytes("compactSignature", hex, l * 2);
        return new Signature2(slcNum(hex, 0, l), slcNum(hex, l, 2 * l));
      }
      // DER encoded ECDSA signature
      // https://bitcoin.stackexchange.com/questions/57644/what-are-the-parts-of-a-bitcoin-transaction-input-script
      static fromDER(hex) {
        const { r, s } = DER.toSig(ensureBytes("DER", hex));
        return new Signature2(r, s);
      }
      assertValidity() {
        if (!isWithinCurveOrder(this.r))
          throw new Error("r must be 0 < r < CURVE.n");
        if (!isWithinCurveOrder(this.s))
          throw new Error("s must be 0 < s < CURVE.n");
      }
      addRecoveryBit(recovery) {
        return new Signature2(this.r, this.s, recovery);
      }
      recoverPublicKey(msgHash) {
        const { r, s, recovery: rec } = this;
        const h = bits2int_modN(ensureBytes("msgHash", msgHash));
        if (rec == null || ![0, 1, 2, 3].includes(rec))
          throw new Error("recovery id invalid");
        const radj = rec === 2 || rec === 3 ? r + CURVE.n : r;
        if (radj >= Fp2.ORDER)
          throw new Error("recovery id 2 or 3 invalid");
        const prefix = (rec & 1) === 0 ? "02" : "03";
        const R = Point2.fromHex(prefix + numToNByteStr(radj));
        const ir = invN(radj);
        const u1 = modN(-h * ir);
        const u2 = modN(s * ir);
        const Q2 = Point2.BASE.multiplyAndAddUnsafe(R, u1, u2);
        if (!Q2)
          throw new Error("point at infinify");
        Q2.assertValidity();
        return Q2;
      }
      // Signatures should be low-s, to prevent malleability.
      hasHighS() {
        return isBiggerThanHalfOrder(this.s);
      }
      normalizeS() {
        return this.hasHighS() ? new Signature2(this.r, modN(-this.s), this.recovery) : this;
      }
      // DER-encoded
      toDERRawBytes() {
        return hexToBytes(this.toDERHex());
      }
      toDERHex() {
        return DER.hexFromSig({ r: this.r, s: this.s });
      }
      // padded bytes of r, then padded bytes of s
      toCompactRawBytes() {
        return hexToBytes(this.toCompactHex());
      }
      toCompactHex() {
        return numToNByteStr(this.r) + numToNByteStr(this.s);
      }
    }
    const utils = {
      isValidPrivateKey(privateKey) {
        try {
          normPrivateKeyToScalar(privateKey);
          return true;
        } catch (error) {
          return false;
        }
      },
      normPrivateKeyToScalar,
      /**
       * Produces cryptographically secure private key from random of size
       * (groupLen + ceil(groupLen / 2)) with modulo bias being negligible.
       */
      randomPrivateKey: () => {
        const length = getMinHashLength(CURVE.n);
        return mapHashToField(CURVE.randomBytes(length), CURVE.n);
      },
      /**
       * Creates precompute table for an arbitrary EC point. Makes point "cached".
       * Allows to massively speed-up `point.multiply(scalar)`.
       * @returns cached point
       * @example
       * const fast = utils.precompute(8, ProjectivePoint.fromHex(someonesPubKey));
       * fast.multiply(privKey); // much faster ECDH now
       */
      precompute(windowSize = 8, point = Point2.BASE) {
        point._setWindowSize(windowSize);
        point.multiply(BigInt(3));
        return point;
      }
    };
    function getPublicKey(privateKey, isCompressed = true) {
      return Point2.fromPrivateKey(privateKey).toRawBytes(isCompressed);
    }
    function isProbPub(item) {
      const arr = item instanceof Uint8Array;
      const str = typeof item === "string";
      const len = (arr || str) && item.length;
      if (arr)
        return len === compressedLen || len === uncompressedLen;
      if (str)
        return len === 2 * compressedLen || len === 2 * uncompressedLen;
      if (item instanceof Point2)
        return true;
      return false;
    }
    function getSharedSecret(privateA, publicB, isCompressed = true) {
      if (isProbPub(privateA))
        throw new Error("first arg must be private key");
      if (!isProbPub(publicB))
        throw new Error("second arg must be public key");
      const b2 = Point2.fromHex(publicB);
      return b2.multiply(normPrivateKeyToScalar(privateA)).toRawBytes(isCompressed);
    }
    const bits2int = CURVE.bits2int || function(bytes2) {
      const num = bytesToNumberBE(bytes2);
      const delta = bytes2.length * 8 - CURVE.nBitLength;
      return delta > 0 ? num >> BigInt(delta) : num;
    };
    const bits2int_modN = CURVE.bits2int_modN || function(bytes2) {
      return modN(bits2int(bytes2));
    };
    const ORDER_MASK = bitMask(CURVE.nBitLength);
    function int2octets(num) {
      if (typeof num !== "bigint")
        throw new Error("bigint expected");
      if (!(_0n5 <= num && num < ORDER_MASK))
        throw new Error(`bigint expected < 2^${CURVE.nBitLength}`);
      return numberToBytesBE(num, CURVE.nByteLength);
    }
    function prepSig(msgHash, privateKey, opts = defaultSigOpts) {
      if (["recovered", "canonical"].some((k) => k in opts))
        throw new Error("sign() legacy options not supported");
      const { hash: hash2, randomBytes: randomBytes3 } = CURVE;
      let { lowS, prehash, extraEntropy: ent } = opts;
      if (lowS == null)
        lowS = true;
      msgHash = ensureBytes("msgHash", msgHash);
      if (prehash)
        msgHash = ensureBytes("prehashed msgHash", hash2(msgHash));
      const h1int = bits2int_modN(msgHash);
      const d = normPrivateKeyToScalar(privateKey);
      const seedArgs = [int2octets(d), int2octets(h1int)];
      if (ent != null) {
        const e = ent === true ? randomBytes3(Fp2.BYTES) : ent;
        seedArgs.push(ensureBytes("extraEntropy", e));
      }
      const seed = concatBytes2(...seedArgs);
      const m = h1int;
      function k2sig(kBytes) {
        const k = bits2int(kBytes);
        if (!isWithinCurveOrder(k))
          return;
        const ik = invN(k);
        const q = Point2.BASE.multiply(k).toAffine();
        const r = modN(q.x);
        if (r === _0n5)
          return;
        const s = modN(ik * modN(m + r * d));
        if (s === _0n5)
          return;
        let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n5);
        let normS = s;
        if (lowS && isBiggerThanHalfOrder(s)) {
          normS = normalizeS(s);
          recovery ^= 1;
        }
        return new Signature2(r, normS, recovery);
      }
      return { seed, k2sig };
    }
    const defaultSigOpts = { lowS: CURVE.lowS, prehash: false };
    const defaultVerOpts = { lowS: CURVE.lowS, prehash: false };
    function sign2(msgHash, privKey, opts = defaultSigOpts) {
      const { seed, k2sig } = prepSig(msgHash, privKey, opts);
      const C = CURVE;
      const drbg = createHmacDrbg(C.hash.outputLen, C.nByteLength, C.hmac);
      return drbg(seed, k2sig);
    }
    Point2.BASE._setWindowSize(8);
    function verify(signature, msgHash, publicKey, opts = defaultVerOpts) {
      const sg = signature;
      msgHash = ensureBytes("msgHash", msgHash);
      publicKey = ensureBytes("publicKey", publicKey);
      if ("strict" in opts)
        throw new Error("options.strict was renamed to lowS");
      const { lowS, prehash } = opts;
      let _sig = void 0;
      let P;
      try {
        if (typeof sg === "string" || sg instanceof Uint8Array) {
          try {
            _sig = Signature2.fromDER(sg);
          } catch (derError) {
            if (!(derError instanceof DER.Err))
              throw derError;
            _sig = Signature2.fromCompact(sg);
          }
        } else if (typeof sg === "object" && typeof sg.r === "bigint" && typeof sg.s === "bigint") {
          const { r: r2, s: s2 } = sg;
          _sig = new Signature2(r2, s2);
        } else {
          throw new Error("PARSE");
        }
        P = Point2.fromHex(publicKey);
      } catch (error) {
        if (error.message === "PARSE")
          throw new Error(`signature must be Signature instance, Uint8Array or hex string`);
        return false;
      }
      if (lowS && _sig.hasHighS())
        return false;
      if (prehash)
        msgHash = CURVE.hash(msgHash);
      const { r, s } = _sig;
      const h = bits2int_modN(msgHash);
      const is = invN(s);
      const u1 = modN(h * is);
      const u2 = modN(r * is);
      const R = Point2.BASE.multiplyAndAddUnsafe(P, u1, u2)?.toAffine();
      if (!R)
        return false;
      const v = modN(R.x);
      return v === r;
    }
    return {
      CURVE,
      getPublicKey,
      getSharedSecret,
      sign: sign2,
      verify,
      ProjectivePoint: Point2,
      Signature: Signature2,
      utils
    };
  }

  // node_modules/@noble/curves/esm/_shortw_utils.js
  function getHash(hash2) {
    return {
      hash: hash2,
      hmac: (key, ...msgs) => hmac(hash2, key, concatBytes(...msgs)),
      randomBytes
    };
  }
  function createCurve(curveDef, defHash) {
    const create = (hash2) => weierstrass({ ...curveDef, ...getHash(hash2) });
    return Object.freeze({ ...create(defHash), create });
  }

  // node_modules/@noble/curves/esm/secp256k1.js
  var secp256k1P = BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f");
  var secp256k1N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  var _1n6 = BigInt(1);
  var _2n5 = BigInt(2);
  var divNearest = (a, b2) => (a + b2 / _2n5) / b2;
  function sqrtMod(y) {
    const P = secp256k1P;
    const _3n5 = BigInt(3), _6n = BigInt(6), _11n2 = BigInt(11), _22n2 = BigInt(22);
    const _23n = BigInt(23), _44n2 = BigInt(44), _88n2 = BigInt(88);
    const b2 = y * y * y % P;
    const b3 = b2 * b2 * y % P;
    const b6 = pow2(b3, _3n5, P) * b3 % P;
    const b9 = pow2(b6, _3n5, P) * b3 % P;
    const b11 = pow2(b9, _2n5, P) * b2 % P;
    const b22 = pow2(b11, _11n2, P) * b11 % P;
    const b44 = pow2(b22, _22n2, P) * b22 % P;
    const b88 = pow2(b44, _44n2, P) * b44 % P;
    const b176 = pow2(b88, _88n2, P) * b88 % P;
    const b220 = pow2(b176, _44n2, P) * b44 % P;
    const b223 = pow2(b220, _3n5, P) * b3 % P;
    const t1 = pow2(b223, _23n, P) * b22 % P;
    const t2 = pow2(t1, _6n, P) * b2 % P;
    const root = pow2(t2, _2n5, P);
    if (!Fp.eql(Fp.sqr(root), y))
      throw new Error("Cannot find square root");
    return root;
  }
  var Fp = Field(secp256k1P, void 0, void 0, { sqrt: sqrtMod });
  var secp256k1 = createCurve({
    a: BigInt(0),
    b: BigInt(7),
    Fp,
    n: secp256k1N,
    // Base point (x, y) aka generator point
    Gx: BigInt("55066263022277343669578718895168534326250603453777594175500187360389116729240"),
    Gy: BigInt("32670510020758816978083085130507043184471273380659243275938904335757337482424"),
    h: BigInt(1),
    lowS: true,
    /**
     * secp256k1 belongs to Koblitz curves: it has efficiently computable endomorphism.
     * Endomorphism uses 2x less RAM, speeds up precomputation by 2x and ECDH / key recovery by 20%.
     * For precomputed wNAF it trades off 1/2 init time & 1/3 ram for 20% perf hit.
     * Explanation: https://gist.github.com/paulmillr/eb670806793e84df628a7c434a873066
     */
    endo: {
      beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
      splitScalar: (k) => {
        const n2 = secp256k1N;
        const a1 = BigInt("0x3086d221a7d46bcde86c90e49284eb15");
        const b1 = -_1n6 * BigInt("0xe4437ed6010e88286f547fa90abfe4c3");
        const a2 = BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8");
        const b2 = a1;
        const POW_2_128 = BigInt("0x100000000000000000000000000000000");
        const c1 = divNearest(b2 * k, n2);
        const c2 = divNearest(-b1 * k, n2);
        let k1 = mod(k - c1 * a1 - c2 * a2, n2);
        let k2 = mod(-c1 * b1 - c2 * b2, n2);
        const k1neg = k1 > POW_2_128;
        const k2neg = k2 > POW_2_128;
        if (k1neg)
          k1 = n2 - k1;
        if (k2neg)
          k2 = n2 - k2;
        if (k1 > POW_2_128 || k2 > POW_2_128) {
          throw new Error("splitScalar: Endomorphism failed, k=" + k);
        }
        return { k1neg, k1, k2neg, k2 };
      }
    }
  }, sha256);
  var _0n6 = BigInt(0);
  var Point = secp256k1.ProjectivePoint;

  // node_modules/ethers/lib.esm/constants/hashes.js
  var ZeroHash = "0x0000000000000000000000000000000000000000000000000000000000000000";

  // node_modules/ethers/lib.esm/constants/strings.js
  var MessagePrefix = "Ethereum Signed Message:\n";

  // node_modules/ethers/lib.esm/crypto/signature.js
  var BN_02 = BigInt(0);
  var BN_12 = BigInt(1);
  var BN_2 = BigInt(2);
  var BN_27 = BigInt(27);
  var BN_28 = BigInt(28);
  var BN_35 = BigInt(35);
  var BN_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  var BN_N_2 = BN_N / BN_2;
  var inspect = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");
  var _guard2 = {};
  function toUint256(value) {
    return zeroPadValue(toBeArray(value), 32);
  }
  var Signature = class _Signature {
    #r;
    #s;
    #v;
    #networkV;
    /**
     *  The ``r`` value for a signature.
     *
     *  This represents the ``x`` coordinate of a "reference" or
     *  challenge point, from which the ``y`` can be computed.
     */
    get r() {
      return this.#r;
    }
    set r(value) {
      assertArgument(dataLength(value) === 32, "invalid r", "value", value);
      this.#r = hexlify(value);
    }
    /**
     *  The ``s`` value for a signature.
     */
    get s() {
      assertArgument(parseInt(this.#s.substring(0, 3)) < 8, "non-canonical s; use ._s", "s", this.#s);
      return this.#s;
    }
    set s(_value) {
      assertArgument(dataLength(_value) === 32, "invalid s", "value", _value);
      this.#s = hexlify(_value);
    }
    /**
     *  Return the s value, unchecked for EIP-2 compliance.
     *
     *  This should generally not be used and is for situations where
     *  a non-canonical S value might be relevant, such as Frontier blocks
     *  that were mined prior to EIP-2 or invalid Authorization List
     *  signatures.
     */
    get _s() {
      return this.#s;
    }
    /**
     *  Returns true if the Signature is valid for [[link-eip-2]] signatures.
     */
    isValid() {
      const s = BigInt(this.#s);
      return s <= BN_N_2;
    }
    /**
     *  The ``v`` value for a signature.
     *
     *  Since a given ``x`` value for ``r`` has two possible values for
     *  its correspondin ``y``, the ``v`` indicates which of the two ``y``
     *  values to use.
     *
     *  It is normalized to the values ``27`` or ``28`` for legacy
     *  purposes.
     */
    get v() {
      return this.#v;
    }
    set v(value) {
      const v = getNumber(value, "value");
      assertArgument(v === 27 || v === 28, "invalid v", "v", value);
      this.#v = v;
    }
    /**
     *  The EIP-155 ``v`` for legacy transactions. For non-legacy
     *  transactions, this value is ``null``.
     */
    get networkV() {
      return this.#networkV;
    }
    /**
     *  The chain ID for EIP-155 legacy transactions. For non-legacy
     *  transactions, this value is ``null``.
     */
    get legacyChainId() {
      const v = this.networkV;
      if (v == null) {
        return null;
      }
      return _Signature.getChainId(v);
    }
    /**
     *  The ``yParity`` for the signature.
     *
     *  See ``v`` for more details on how this value is used.
     */
    get yParity() {
      return this.v === 27 ? 0 : 1;
    }
    /**
     *  The [[link-eip-2098]] compact representation of the ``yParity``
     *  and ``s`` compacted into a single ``bytes32``.
     */
    get yParityAndS() {
      const yParityAndS = getBytes(this.s);
      if (this.yParity) {
        yParityAndS[0] |= 128;
      }
      return hexlify(yParityAndS);
    }
    /**
     *  The [[link-eip-2098]] compact representation.
     */
    get compactSerialized() {
      return concat([this.r, this.yParityAndS]);
    }
    /**
     *  The serialized representation.
     */
    get serialized() {
      return concat([this.r, this.s, this.yParity ? "0x1c" : "0x1b"]);
    }
    /**
     *  @private
     */
    constructor(guard, r, s, v) {
      assertPrivate(guard, _guard2, "Signature");
      this.#r = r;
      this.#s = s;
      this.#v = v;
      this.#networkV = null;
    }
    /**
     *  Returns the canonical signature.
     *
     *  This is only necessary when dealing with legacy transaction which
     *  did not enforce canonical S values (i.e. [[link-eip-2]]. Most
     *  developers should never require this.
     */
    getCanonical() {
      if (this.isValid()) {
        return this;
      }
      const s = BN_N - BigInt(this._s);
      const v = 55 - this.v;
      const result = new _Signature(_guard2, this.r, toUint256(s), v);
      if (this.networkV) {
        result.#networkV = this.networkV;
      }
      return result;
    }
    /**
     *  Returns a new identical [[Signature]].
     */
    clone() {
      const clone = new _Signature(_guard2, this.r, this._s, this.v);
      if (this.networkV) {
        clone.#networkV = this.networkV;
      }
      return clone;
    }
    /**
     *  Returns a representation that is compatible with ``JSON.stringify``.
     */
    toJSON() {
      const networkV = this.networkV;
      return {
        _type: "signature",
        networkV: networkV != null ? networkV.toString() : null,
        r: this.r,
        s: this._s,
        v: this.v
      };
    }
    [inspect]() {
      return this.toString();
    }
    toString() {
      if (this.isValid()) {
        return `Signature { r: ${this.r}, s: ${this._s}, v: ${this.v} }`;
      }
      return `Signature { r: ${this.r}, s: ${this._s}, v: ${this.v}, valid: false }`;
    }
    /**
     *  Compute the chain ID from the ``v`` in a legacy EIP-155 transactions.
     *
     *  @example:
     *    Signature.getChainId(45)
     *    //_result:
     *
     *    Signature.getChainId(46)
     *    //_result:
     */
    static getChainId(v) {
      const bv = getBigInt(v, "v");
      if (bv == BN_27 || bv == BN_28) {
        return BN_02;
      }
      assertArgument(bv >= BN_35, "invalid EIP-155 v", "v", v);
      return (bv - BN_35) / BN_2;
    }
    /**
     *  Compute the ``v`` for a chain ID for a legacy EIP-155 transactions.
     *
     *  Legacy transactions which use [[link-eip-155]] hijack the ``v``
     *  property to include the chain ID.
     *
     *  @example:
     *    Signature.getChainIdV(5, 27)
     *    //_result:
     *
     *    Signature.getChainIdV(5, 28)
     *    //_result:
     *
     */
    static getChainIdV(chainId, v) {
      return getBigInt(chainId) * BN_2 + BigInt(35 + v - 27);
    }
    /**
     *  Compute the normalized legacy transaction ``v`` from a ``yParirty``,
     *  a legacy transaction ``v`` or a legacy [[link-eip-155]] transaction.
     *
     *  @example:
     *    // The values 0 and 1 imply v is actually yParity
     *    Signature.getNormalizedV(0)
     *    //_result:
     *
     *    // Legacy non-EIP-1559 transaction (i.e. 27 or 28)
     *    Signature.getNormalizedV(27)
     *    //_result:
     *
     *    // Legacy EIP-155 transaction (i.e. >= 35)
     *    Signature.getNormalizedV(46)
     *    //_result:
     *
     *    // Invalid values throw
     *    Signature.getNormalizedV(5)
     *    //_error:
     */
    static getNormalizedV(v) {
      const bv = getBigInt(v);
      if (bv === BN_02 || bv === BN_27) {
        return 27;
      }
      if (bv === BN_12 || bv === BN_28) {
        return 28;
      }
      assertArgument(bv >= BN_35, "invalid v", "v", v);
      return bv & BN_12 ? 27 : 28;
    }
    /**
     *  Creates a new [[Signature]].
     *
     *  If no %%sig%% is provided, a new [[Signature]] is created
     *  with default values.
     *
     *  If %%sig%% is a string, it is parsed.
     */
    static from(sig) {
      function assertError(check, message) {
        assertArgument(check, message, "signature", sig);
      }
      ;
      if (sig == null) {
        return new _Signature(_guard2, ZeroHash, ZeroHash, 27);
      }
      if (typeof sig === "string") {
        const bytes2 = getBytes(sig, "signature");
        if (bytes2.length === 64) {
          const r2 = hexlify(bytes2.slice(0, 32));
          const s2 = bytes2.slice(32, 64);
          const v2 = s2[0] & 128 ? 28 : 27;
          s2[0] &= 127;
          return new _Signature(_guard2, r2, hexlify(s2), v2);
        }
        if (bytes2.length === 65) {
          const r2 = hexlify(bytes2.slice(0, 32));
          const s2 = hexlify(bytes2.slice(32, 64));
          const v2 = _Signature.getNormalizedV(bytes2[64]);
          return new _Signature(_guard2, r2, s2, v2);
        }
        assertError(false, "invalid raw signature length");
      }
      if (sig instanceof _Signature) {
        return sig.clone();
      }
      const _r = sig.r;
      assertError(_r != null, "missing r");
      const r = toUint256(_r);
      const s = (function(s2, yParityAndS) {
        if (s2 != null) {
          return toUint256(s2);
        }
        if (yParityAndS != null) {
          assertError(isHexString(yParityAndS, 32), "invalid yParityAndS");
          const bytes2 = getBytes(yParityAndS);
          bytes2[0] &= 127;
          return hexlify(bytes2);
        }
        assertError(false, "missing s");
      })(sig.s, sig.yParityAndS);
      const { networkV, v } = (function(_v, yParityAndS, yParity) {
        if (_v != null) {
          const v2 = getBigInt(_v);
          return {
            networkV: v2 >= BN_35 ? v2 : void 0,
            v: _Signature.getNormalizedV(v2)
          };
        }
        if (yParityAndS != null) {
          assertError(isHexString(yParityAndS, 32), "invalid yParityAndS");
          return { v: getBytes(yParityAndS)[0] & 128 ? 28 : 27 };
        }
        if (yParity != null) {
          switch (getNumber(yParity, "sig.yParity")) {
            case 0:
              return { v: 27 };
            case 1:
              return { v: 28 };
          }
          assertError(false, "invalid yParity");
        }
        assertError(false, "missing v");
      })(sig.v, sig.yParityAndS, sig.yParity);
      const result = new _Signature(_guard2, r, s, v);
      if (networkV) {
        result.#networkV = networkV;
      }
      assertError(sig.yParity == null || getNumber(sig.yParity, "sig.yParity") === result.yParity, "yParity mismatch");
      assertError(sig.yParityAndS == null || sig.yParityAndS === result.yParityAndS, "yParityAndS mismatch");
      return result;
    }
  };

  // node_modules/ethers/lib.esm/crypto/signing-key.js
  var SigningKey = class _SigningKey {
    #privateKey;
    /**
     *  Creates a new **SigningKey** for %%privateKey%%.
     */
    constructor(privateKey) {
      assertArgument(dataLength(privateKey) === 32, "invalid private key", "privateKey", "[REDACTED]");
      this.#privateKey = hexlify(privateKey);
    }
    /**
     *  The private key.
     */
    get privateKey() {
      return this.#privateKey;
    }
    /**
     *  The uncompressed public key.
     *
     * This will always begin with the prefix ``0x04`` and be 132
     * characters long (the ``0x`` prefix and 130 hexadecimal nibbles).
     */
    get publicKey() {
      return _SigningKey.computePublicKey(this.#privateKey);
    }
    /**
     *  The compressed public key.
     *
     *  This will always begin with either the prefix ``0x02`` or ``0x03``
     *  and be 68 characters long (the ``0x`` prefix and 33 hexadecimal
     *  nibbles)
     */
    get compressedPublicKey() {
      return _SigningKey.computePublicKey(this.#privateKey, true);
    }
    /**
     *  Return the signature of the signed %%digest%%.
     */
    sign(digest) {
      assertArgument(dataLength(digest) === 32, "invalid digest length", "digest", digest);
      const sig = secp256k1.sign(getBytesCopy(digest), getBytesCopy(this.#privateKey), {
        lowS: true
      });
      return Signature.from({
        r: toBeHex(sig.r, 32),
        s: toBeHex(sig.s, 32),
        v: sig.recovery ? 28 : 27
      });
    }
    /**
     *  Returns the [[link-wiki-ecdh]] shared secret between this
     *  private key and the %%other%% key.
     *
     *  The %%other%% key may be any type of key, a raw public key,
     *  a compressed/uncompressed pubic key or aprivate key.
     *
     *  Best practice is usually to use a cryptographic hash on the
     *  returned value before using it as a symetric secret.
     *
     *  @example:
     *    sign1 = new SigningKey(id("some-secret-1"))
     *    sign2 = new SigningKey(id("some-secret-2"))
     *
     *    // Notice that privA.computeSharedSecret(pubB)...
     *    sign1.computeSharedSecret(sign2.publicKey)
     *    //_result:
     *
     *    // ...is equal to privB.computeSharedSecret(pubA).
     *    sign2.computeSharedSecret(sign1.publicKey)
     *    //_result:
     */
    computeSharedSecret(other) {
      const pubKey = _SigningKey.computePublicKey(other);
      return hexlify(secp256k1.getSharedSecret(getBytesCopy(this.#privateKey), getBytes(pubKey), false));
    }
    /**
     *  Compute the public key for %%key%%, optionally %%compressed%%.
     *
     *  The %%key%% may be any type of key, a raw public key, a
     *  compressed/uncompressed public key or private key.
     *
     *  @example:
     *    sign = new SigningKey(id("some-secret"));
     *
     *    // Compute the uncompressed public key for a private key
     *    SigningKey.computePublicKey(sign.privateKey)
     *    //_result:
     *
     *    // Compute the compressed public key for a private key
     *    SigningKey.computePublicKey(sign.privateKey, true)
     *    //_result:
     *
     *    // Compute the uncompressed public key
     *    SigningKey.computePublicKey(sign.publicKey, false);
     *    //_result:
     *
     *    // Compute the Compressed a public key
     *    SigningKey.computePublicKey(sign.publicKey, true);
     *    //_result:
     */
    static computePublicKey(key, compressed) {
      let bytes2 = getBytes(key, "key");
      if (bytes2.length === 32) {
        const pubKey = secp256k1.getPublicKey(bytes2, !!compressed);
        return hexlify(pubKey);
      }
      if (bytes2.length === 64) {
        const pub = new Uint8Array(65);
        pub[0] = 4;
        pub.set(bytes2, 1);
        bytes2 = pub;
      }
      const point = secp256k1.ProjectivePoint.fromHex(bytes2);
      return hexlify(point.toRawBytes(compressed));
    }
    /**
     *  Returns the public key for the private key which produced the
     *  %%signature%% for the given %%digest%%.
     *
     *  @example:
     *    key = new SigningKey(id("some-secret"))
     *    digest = id("hello world")
     *    sig = key.sign(digest)
     *
     *    // Notice the signer public key...
     *    key.publicKey
     *    //_result:
     *
     *    // ...is equal to the recovered public key
     *    SigningKey.recoverPublicKey(digest, sig)
     *    //_result:
     *
     */
    static recoverPublicKey(digest, signature) {
      assertArgument(dataLength(digest) === 32, "invalid digest length", "digest", digest);
      const sig = Signature.from(signature);
      let secpSig = secp256k1.Signature.fromCompact(getBytesCopy(concat([sig.r, sig.s])));
      secpSig = secpSig.addRecoveryBit(sig.yParity);
      const pubKey = secpSig.recoverPublicKey(getBytesCopy(digest));
      assertArgument(pubKey != null, "invalid signature for digest", "signature", signature);
      return "0x" + pubKey.toHex(false);
    }
    /**
     *  Returns the point resulting from adding the ellipic curve points
     *  %%p0%% and %%p1%%.
     *
     *  This is not a common function most developers should require, but
     *  can be useful for certain privacy-specific techniques.
     *
     *  For example, it is used by [[HDNodeWallet]] to compute child
     *  addresses from parent public keys and chain codes.
     */
    static addPoints(p0, p1, compressed) {
      const pub0 = secp256k1.ProjectivePoint.fromHex(_SigningKey.computePublicKey(p0).substring(2));
      const pub1 = secp256k1.ProjectivePoint.fromHex(_SigningKey.computePublicKey(p1).substring(2));
      return "0x" + pub0.add(pub1).toHex(!!compressed);
    }
  };

  // node_modules/ethers/lib.esm/address/address.js
  var BN_03 = BigInt(0);
  var BN_36 = BigInt(36);
  function getChecksumAddress(address) {
    address = address.toLowerCase();
    const chars = address.substring(2).split("");
    const expanded = new Uint8Array(40);
    for (let i = 0; i < 40; i++) {
      expanded[i] = chars[i].charCodeAt(0);
    }
    const hashed = getBytes(keccak256(expanded));
    for (let i = 0; i < 40; i += 2) {
      if (hashed[i >> 1] >> 4 >= 8) {
        chars[i] = chars[i].toUpperCase();
      }
      if ((hashed[i >> 1] & 15) >= 8) {
        chars[i + 1] = chars[i + 1].toUpperCase();
      }
    }
    return "0x" + chars.join("");
  }
  var ibanLookup = {};
  for (let i = 0; i < 10; i++) {
    ibanLookup[String(i)] = String(i);
  }
  for (let i = 0; i < 26; i++) {
    ibanLookup[String.fromCharCode(65 + i)] = String(10 + i);
  }
  var safeDigits = 15;
  function ibanChecksum(address) {
    address = address.toUpperCase();
    address = address.substring(4) + address.substring(0, 2) + "00";
    let expanded = address.split("").map((c) => {
      return ibanLookup[c];
    }).join("");
    while (expanded.length >= safeDigits) {
      let block = expanded.substring(0, safeDigits);
      expanded = parseInt(block, 10) % 97 + expanded.substring(block.length);
    }
    let checksum = String(98 - parseInt(expanded, 10) % 97);
    while (checksum.length < 2) {
      checksum = "0" + checksum;
    }
    return checksum;
  }
  var Base36 = (function() {
    ;
    const result = {};
    for (let i = 0; i < 36; i++) {
      const key = "0123456789abcdefghijklmnopqrstuvwxyz"[i];
      result[key] = BigInt(i);
    }
    return result;
  })();
  function fromBase36(value) {
    value = value.toLowerCase();
    let result = BN_03;
    for (let i = 0; i < value.length; i++) {
      result = result * BN_36 + Base36[value[i]];
    }
    return result;
  }
  function getAddress(address) {
    assertArgument(typeof address === "string", "invalid address", "address", address);
    if (address.match(/^(0x)?[0-9a-fA-F]{40}$/)) {
      if (!address.startsWith("0x")) {
        address = "0x" + address;
      }
      const result = getChecksumAddress(address);
      assertArgument(!address.match(/([A-F].*[a-f])|([a-f].*[A-F])/) || result === address, "bad address checksum", "address", address);
      return result;
    }
    if (address.match(/^XE[0-9]{2}[0-9A-Za-z]{30,31}$/)) {
      assertArgument(address.substring(2, 4) === ibanChecksum(address), "bad icap checksum", "address", address);
      let result = fromBase36(address.substring(4)).toString(16);
      while (result.length < 40) {
        result = "0" + result;
      }
      return getChecksumAddress("0x" + result);
    }
    assertArgument(false, "invalid address", "address", address);
  }

  // node_modules/ethers/lib.esm/abi/typed.js
  var _gaurd = {};
  function n(value, width) {
    let signed = false;
    if (width < 0) {
      signed = true;
      width *= -1;
    }
    return new Typed(_gaurd, `${signed ? "" : "u"}int${width}`, value, { signed, width });
  }
  function b(value, size) {
    return new Typed(_gaurd, `bytes${size ? size : ""}`, value, { size });
  }
  var _typedSymbol = /* @__PURE__ */ Symbol.for("_ethers_typed");
  var Typed = class _Typed {
    /**
     *  The type, as a Solidity-compatible type.
     */
    type;
    /**
     *  The actual value.
     */
    value;
    #options;
    /**
     *  @_ignore:
     */
    _typedSymbol;
    /**
     *  @_ignore:
     */
    constructor(gaurd, type, value, options) {
      if (options == null) {
        options = null;
      }
      assertPrivate(_gaurd, gaurd, "Typed");
      defineProperties(this, { _typedSymbol, type, value });
      this.#options = options;
      this.format();
    }
    /**
     *  Format the type as a Human-Readable type.
     */
    format() {
      if (this.type === "array") {
        throw new Error("");
      } else if (this.type === "dynamicArray") {
        throw new Error("");
      } else if (this.type === "tuple") {
        return `tuple(${this.value.map((v) => v.format()).join(",")})`;
      }
      return this.type;
    }
    /**
     *  The default value returned by this type.
     */
    defaultValue() {
      return 0;
    }
    /**
     *  The minimum value for numeric types.
     */
    minValue() {
      return 0;
    }
    /**
     *  The maximum value for numeric types.
     */
    maxValue() {
      return 0;
    }
    /**
     *  Returns ``true`` and provides a type guard is this is a [[TypedBigInt]].
     */
    isBigInt() {
      return !!this.type.match(/^u?int[0-9]+$/);
    }
    /**
     *  Returns ``true`` and provides a type guard is this is a [[TypedData]].
     */
    isData() {
      return this.type.startsWith("bytes");
    }
    /**
     *  Returns ``true`` and provides a type guard is this is a [[TypedString]].
     */
    isString() {
      return this.type === "string";
    }
    /**
     *  Returns the tuple name, if this is a tuple. Throws otherwise.
     */
    get tupleName() {
      if (this.type !== "tuple") {
        throw TypeError("not a tuple");
      }
      return this.#options;
    }
    // Returns the length of this type as an array
    // - `null` indicates the length is unforced, it could be dynamic
    // - `-1` indicates the length is dynamic
    // - any other value indicates it is a static array and is its length
    /**
     *  Returns the length of the array type or ``-1`` if it is dynamic.
     *
     *  Throws if the type is not an array.
     */
    get arrayLength() {
      if (this.type !== "array") {
        throw TypeError("not an array");
      }
      if (this.#options === true) {
        return -1;
      }
      if (this.#options === false) {
        return this.value.length;
      }
      return null;
    }
    /**
     *  Returns a new **Typed** of %%type%% with the %%value%%.
     */
    static from(type, value) {
      return new _Typed(_gaurd, type, value);
    }
    /**
     *  Return a new ``uint8`` type for %%v%%.
     */
    static uint8(v) {
      return n(v, 8);
    }
    /**
     *  Return a new ``uint16`` type for %%v%%.
     */
    static uint16(v) {
      return n(v, 16);
    }
    /**
     *  Return a new ``uint24`` type for %%v%%.
     */
    static uint24(v) {
      return n(v, 24);
    }
    /**
     *  Return a new ``uint32`` type for %%v%%.
     */
    static uint32(v) {
      return n(v, 32);
    }
    /**
     *  Return a new ``uint40`` type for %%v%%.
     */
    static uint40(v) {
      return n(v, 40);
    }
    /**
     *  Return a new ``uint48`` type for %%v%%.
     */
    static uint48(v) {
      return n(v, 48);
    }
    /**
     *  Return a new ``uint56`` type for %%v%%.
     */
    static uint56(v) {
      return n(v, 56);
    }
    /**
     *  Return a new ``uint64`` type for %%v%%.
     */
    static uint64(v) {
      return n(v, 64);
    }
    /**
     *  Return a new ``uint72`` type for %%v%%.
     */
    static uint72(v) {
      return n(v, 72);
    }
    /**
     *  Return a new ``uint80`` type for %%v%%.
     */
    static uint80(v) {
      return n(v, 80);
    }
    /**
     *  Return a new ``uint88`` type for %%v%%.
     */
    static uint88(v) {
      return n(v, 88);
    }
    /**
     *  Return a new ``uint96`` type for %%v%%.
     */
    static uint96(v) {
      return n(v, 96);
    }
    /**
     *  Return a new ``uint104`` type for %%v%%.
     */
    static uint104(v) {
      return n(v, 104);
    }
    /**
     *  Return a new ``uint112`` type for %%v%%.
     */
    static uint112(v) {
      return n(v, 112);
    }
    /**
     *  Return a new ``uint120`` type for %%v%%.
     */
    static uint120(v) {
      return n(v, 120);
    }
    /**
     *  Return a new ``uint128`` type for %%v%%.
     */
    static uint128(v) {
      return n(v, 128);
    }
    /**
     *  Return a new ``uint136`` type for %%v%%.
     */
    static uint136(v) {
      return n(v, 136);
    }
    /**
     *  Return a new ``uint144`` type for %%v%%.
     */
    static uint144(v) {
      return n(v, 144);
    }
    /**
     *  Return a new ``uint152`` type for %%v%%.
     */
    static uint152(v) {
      return n(v, 152);
    }
    /**
     *  Return a new ``uint160`` type for %%v%%.
     */
    static uint160(v) {
      return n(v, 160);
    }
    /**
     *  Return a new ``uint168`` type for %%v%%.
     */
    static uint168(v) {
      return n(v, 168);
    }
    /**
     *  Return a new ``uint176`` type for %%v%%.
     */
    static uint176(v) {
      return n(v, 176);
    }
    /**
     *  Return a new ``uint184`` type for %%v%%.
     */
    static uint184(v) {
      return n(v, 184);
    }
    /**
     *  Return a new ``uint192`` type for %%v%%.
     */
    static uint192(v) {
      return n(v, 192);
    }
    /**
     *  Return a new ``uint200`` type for %%v%%.
     */
    static uint200(v) {
      return n(v, 200);
    }
    /**
     *  Return a new ``uint208`` type for %%v%%.
     */
    static uint208(v) {
      return n(v, 208);
    }
    /**
     *  Return a new ``uint216`` type for %%v%%.
     */
    static uint216(v) {
      return n(v, 216);
    }
    /**
     *  Return a new ``uint224`` type for %%v%%.
     */
    static uint224(v) {
      return n(v, 224);
    }
    /**
     *  Return a new ``uint232`` type for %%v%%.
     */
    static uint232(v) {
      return n(v, 232);
    }
    /**
     *  Return a new ``uint240`` type for %%v%%.
     */
    static uint240(v) {
      return n(v, 240);
    }
    /**
     *  Return a new ``uint248`` type for %%v%%.
     */
    static uint248(v) {
      return n(v, 248);
    }
    /**
     *  Return a new ``uint256`` type for %%v%%.
     */
    static uint256(v) {
      return n(v, 256);
    }
    /**
     *  Return a new ``uint256`` type for %%v%%.
     */
    static uint(v) {
      return n(v, 256);
    }
    /**
     *  Return a new ``int8`` type for %%v%%.
     */
    static int8(v) {
      return n(v, -8);
    }
    /**
     *  Return a new ``int16`` type for %%v%%.
     */
    static int16(v) {
      return n(v, -16);
    }
    /**
     *  Return a new ``int24`` type for %%v%%.
     */
    static int24(v) {
      return n(v, -24);
    }
    /**
     *  Return a new ``int32`` type for %%v%%.
     */
    static int32(v) {
      return n(v, -32);
    }
    /**
     *  Return a new ``int40`` type for %%v%%.
     */
    static int40(v) {
      return n(v, -40);
    }
    /**
     *  Return a new ``int48`` type for %%v%%.
     */
    static int48(v) {
      return n(v, -48);
    }
    /**
     *  Return a new ``int56`` type for %%v%%.
     */
    static int56(v) {
      return n(v, -56);
    }
    /**
     *  Return a new ``int64`` type for %%v%%.
     */
    static int64(v) {
      return n(v, -64);
    }
    /**
     *  Return a new ``int72`` type for %%v%%.
     */
    static int72(v) {
      return n(v, -72);
    }
    /**
     *  Return a new ``int80`` type for %%v%%.
     */
    static int80(v) {
      return n(v, -80);
    }
    /**
     *  Return a new ``int88`` type for %%v%%.
     */
    static int88(v) {
      return n(v, -88);
    }
    /**
     *  Return a new ``int96`` type for %%v%%.
     */
    static int96(v) {
      return n(v, -96);
    }
    /**
     *  Return a new ``int104`` type for %%v%%.
     */
    static int104(v) {
      return n(v, -104);
    }
    /**
     *  Return a new ``int112`` type for %%v%%.
     */
    static int112(v) {
      return n(v, -112);
    }
    /**
     *  Return a new ``int120`` type for %%v%%.
     */
    static int120(v) {
      return n(v, -120);
    }
    /**
     *  Return a new ``int128`` type for %%v%%.
     */
    static int128(v) {
      return n(v, -128);
    }
    /**
     *  Return a new ``int136`` type for %%v%%.
     */
    static int136(v) {
      return n(v, -136);
    }
    /**
     *  Return a new ``int144`` type for %%v%%.
     */
    static int144(v) {
      return n(v, -144);
    }
    /**
     *  Return a new ``int52`` type for %%v%%.
     */
    static int152(v) {
      return n(v, -152);
    }
    /**
     *  Return a new ``int160`` type for %%v%%.
     */
    static int160(v) {
      return n(v, -160);
    }
    /**
     *  Return a new ``int168`` type for %%v%%.
     */
    static int168(v) {
      return n(v, -168);
    }
    /**
     *  Return a new ``int176`` type for %%v%%.
     */
    static int176(v) {
      return n(v, -176);
    }
    /**
     *  Return a new ``int184`` type for %%v%%.
     */
    static int184(v) {
      return n(v, -184);
    }
    /**
     *  Return a new ``int92`` type for %%v%%.
     */
    static int192(v) {
      return n(v, -192);
    }
    /**
     *  Return a new ``int200`` type for %%v%%.
     */
    static int200(v) {
      return n(v, -200);
    }
    /**
     *  Return a new ``int208`` type for %%v%%.
     */
    static int208(v) {
      return n(v, -208);
    }
    /**
     *  Return a new ``int216`` type for %%v%%.
     */
    static int216(v) {
      return n(v, -216);
    }
    /**
     *  Return a new ``int224`` type for %%v%%.
     */
    static int224(v) {
      return n(v, -224);
    }
    /**
     *  Return a new ``int232`` type for %%v%%.
     */
    static int232(v) {
      return n(v, -232);
    }
    /**
     *  Return a new ``int240`` type for %%v%%.
     */
    static int240(v) {
      return n(v, -240);
    }
    /**
     *  Return a new ``int248`` type for %%v%%.
     */
    static int248(v) {
      return n(v, -248);
    }
    /**
     *  Return a new ``int256`` type for %%v%%.
     */
    static int256(v) {
      return n(v, -256);
    }
    /**
     *  Return a new ``int256`` type for %%v%%.
     */
    static int(v) {
      return n(v, -256);
    }
    /**
     *  Return a new ``bytes1`` type for %%v%%.
     */
    static bytes1(v) {
      return b(v, 1);
    }
    /**
     *  Return a new ``bytes2`` type for %%v%%.
     */
    static bytes2(v) {
      return b(v, 2);
    }
    /**
     *  Return a new ``bytes3`` type for %%v%%.
     */
    static bytes3(v) {
      return b(v, 3);
    }
    /**
     *  Return a new ``bytes4`` type for %%v%%.
     */
    static bytes4(v) {
      return b(v, 4);
    }
    /**
     *  Return a new ``bytes5`` type for %%v%%.
     */
    static bytes5(v) {
      return b(v, 5);
    }
    /**
     *  Return a new ``bytes6`` type for %%v%%.
     */
    static bytes6(v) {
      return b(v, 6);
    }
    /**
     *  Return a new ``bytes7`` type for %%v%%.
     */
    static bytes7(v) {
      return b(v, 7);
    }
    /**
     *  Return a new ``bytes8`` type for %%v%%.
     */
    static bytes8(v) {
      return b(v, 8);
    }
    /**
     *  Return a new ``bytes9`` type for %%v%%.
     */
    static bytes9(v) {
      return b(v, 9);
    }
    /**
     *  Return a new ``bytes10`` type for %%v%%.
     */
    static bytes10(v) {
      return b(v, 10);
    }
    /**
     *  Return a new ``bytes11`` type for %%v%%.
     */
    static bytes11(v) {
      return b(v, 11);
    }
    /**
     *  Return a new ``bytes12`` type for %%v%%.
     */
    static bytes12(v) {
      return b(v, 12);
    }
    /**
     *  Return a new ``bytes13`` type for %%v%%.
     */
    static bytes13(v) {
      return b(v, 13);
    }
    /**
     *  Return a new ``bytes14`` type for %%v%%.
     */
    static bytes14(v) {
      return b(v, 14);
    }
    /**
     *  Return a new ``bytes15`` type for %%v%%.
     */
    static bytes15(v) {
      return b(v, 15);
    }
    /**
     *  Return a new ``bytes16`` type for %%v%%.
     */
    static bytes16(v) {
      return b(v, 16);
    }
    /**
     *  Return a new ``bytes17`` type for %%v%%.
     */
    static bytes17(v) {
      return b(v, 17);
    }
    /**
     *  Return a new ``bytes18`` type for %%v%%.
     */
    static bytes18(v) {
      return b(v, 18);
    }
    /**
     *  Return a new ``bytes19`` type for %%v%%.
     */
    static bytes19(v) {
      return b(v, 19);
    }
    /**
     *  Return a new ``bytes20`` type for %%v%%.
     */
    static bytes20(v) {
      return b(v, 20);
    }
    /**
     *  Return a new ``bytes21`` type for %%v%%.
     */
    static bytes21(v) {
      return b(v, 21);
    }
    /**
     *  Return a new ``bytes22`` type for %%v%%.
     */
    static bytes22(v) {
      return b(v, 22);
    }
    /**
     *  Return a new ``bytes23`` type for %%v%%.
     */
    static bytes23(v) {
      return b(v, 23);
    }
    /**
     *  Return a new ``bytes24`` type for %%v%%.
     */
    static bytes24(v) {
      return b(v, 24);
    }
    /**
     *  Return a new ``bytes25`` type for %%v%%.
     */
    static bytes25(v) {
      return b(v, 25);
    }
    /**
     *  Return a new ``bytes26`` type for %%v%%.
     */
    static bytes26(v) {
      return b(v, 26);
    }
    /**
     *  Return a new ``bytes27`` type for %%v%%.
     */
    static bytes27(v) {
      return b(v, 27);
    }
    /**
     *  Return a new ``bytes28`` type for %%v%%.
     */
    static bytes28(v) {
      return b(v, 28);
    }
    /**
     *  Return a new ``bytes29`` type for %%v%%.
     */
    static bytes29(v) {
      return b(v, 29);
    }
    /**
     *  Return a new ``bytes30`` type for %%v%%.
     */
    static bytes30(v) {
      return b(v, 30);
    }
    /**
     *  Return a new ``bytes31`` type for %%v%%.
     */
    static bytes31(v) {
      return b(v, 31);
    }
    /**
     *  Return a new ``bytes32`` type for %%v%%.
     */
    static bytes32(v) {
      return b(v, 32);
    }
    /**
     *  Return a new ``address`` type for %%v%%.
     */
    static address(v) {
      return new _Typed(_gaurd, "address", v);
    }
    /**
     *  Return a new ``bool`` type for %%v%%.
     */
    static bool(v) {
      return new _Typed(_gaurd, "bool", !!v);
    }
    /**
     *  Return a new ``bytes`` type for %%v%%.
     */
    static bytes(v) {
      return new _Typed(_gaurd, "bytes", v);
    }
    /**
     *  Return a new ``string`` type for %%v%%.
     */
    static string(v) {
      return new _Typed(_gaurd, "string", v);
    }
    /**
     *  Return a new ``array`` type for %%v%%, allowing %%dynamic%% length.
     */
    static array(v, dynamic) {
      throw new Error("not implemented yet");
      return new _Typed(_gaurd, "array", v, dynamic);
    }
    /**
     *  Return a new ``tuple`` type for %%v%%, with the optional %%name%%.
     */
    static tuple(v, name) {
      throw new Error("not implemented yet");
      return new _Typed(_gaurd, "tuple", v, name);
    }
    /**
     *  Return a new ``uint8`` type for %%v%%.
     */
    static overrides(v) {
      return new _Typed(_gaurd, "overrides", Object.assign({}, v));
    }
    /**
     *  Returns true only if %%value%% is a [[Typed]] instance.
     */
    static isTyped(value) {
      return value && typeof value === "object" && "_typedSymbol" in value && value._typedSymbol === _typedSymbol;
    }
    /**
     *  If the value is a [[Typed]] instance, validates the underlying value
     *  and returns it, otherwise returns value directly.
     *
     *  This is useful for functions that with to accept either a [[Typed]]
     *  object or values.
     */
    static dereference(value, type) {
      if (_Typed.isTyped(value)) {
        if (value.type !== type) {
          throw new Error(`invalid type: expecetd ${type}, got ${value.type}`);
        }
        return value.value;
      }
      return value;
    }
  };

  // node_modules/ethers/lib.esm/abi/coders/address.js
  var AddressCoder = class extends Coder {
    constructor(localName) {
      super("address", "address", localName, false);
    }
    defaultValue() {
      return "0x0000000000000000000000000000000000000000";
    }
    encode(writer, _value) {
      let value = Typed.dereference(_value, "string");
      try {
        value = getAddress(value);
      } catch (error) {
        return this._throwError(error.message, _value);
      }
      return writer.writeValue(value);
    }
    decode(reader) {
      return getAddress(toBeHex(reader.readValue(), 20));
    }
  };

  // node_modules/ethers/lib.esm/abi/coders/anonymous.js
  var AnonymousCoder = class extends Coder {
    coder;
    constructor(coder) {
      super(coder.name, coder.type, "_", coder.dynamic);
      this.coder = coder;
    }
    defaultValue() {
      return this.coder.defaultValue();
    }
    encode(writer, value) {
      return this.coder.encode(writer, value);
    }
    decode(reader) {
      return this.coder.decode(reader);
    }
  };

  // node_modules/ethers/lib.esm/abi/coders/array.js
  function pack(writer, coders, values) {
    let arrayValues = [];
    if (Array.isArray(values)) {
      arrayValues = values;
    } else if (values && typeof values === "object") {
      let unique = {};
      arrayValues = coders.map((coder) => {
        const name = coder.localName;
        assert(name, "cannot encode object for signature with missing names", "INVALID_ARGUMENT", { argument: "values", info: { coder }, value: values });
        assert(!unique[name], "cannot encode object for signature with duplicate names", "INVALID_ARGUMENT", { argument: "values", info: { coder }, value: values });
        unique[name] = true;
        return values[name];
      });
    } else {
      assertArgument(false, "invalid tuple value", "tuple", values);
    }
    assertArgument(coders.length === arrayValues.length, "types/value length mismatch", "tuple", values);
    let staticWriter = new Writer();
    let dynamicWriter = new Writer();
    let updateFuncs = [];
    coders.forEach((coder, index) => {
      let value = arrayValues[index];
      if (coder.dynamic) {
        let dynamicOffset = dynamicWriter.length;
        coder.encode(dynamicWriter, value);
        let updateFunc = staticWriter.writeUpdatableValue();
        updateFuncs.push((baseOffset) => {
          updateFunc(baseOffset + dynamicOffset);
        });
      } else {
        coder.encode(staticWriter, value);
      }
    });
    updateFuncs.forEach((func) => {
      func(staticWriter.length);
    });
    let length = writer.appendWriter(staticWriter);
    length += writer.appendWriter(dynamicWriter);
    return length;
  }
  function unpack(reader, coders) {
    let values = [];
    let keys = [];
    let baseReader = reader.subReader(0);
    coders.forEach((coder) => {
      let value = null;
      if (coder.dynamic) {
        let offset = reader.readIndex();
        let offsetReader = baseReader.subReader(offset);
        try {
          value = coder.decode(offsetReader);
        } catch (error) {
          if (isError(error, "BUFFER_OVERRUN")) {
            throw error;
          }
          value = error;
          value.baseType = coder.name;
          value.name = coder.localName;
          value.type = coder.type;
        }
      } else {
        try {
          value = coder.decode(reader);
        } catch (error) {
          if (isError(error, "BUFFER_OVERRUN")) {
            throw error;
          }
          value = error;
          value.baseType = coder.name;
          value.name = coder.localName;
          value.type = coder.type;
        }
      }
      if (value == void 0) {
        throw new Error("investigate");
      }
      values.push(value);
      keys.push(coder.localName || null);
    });
    return Result.fromItems(values, keys);
  }
  var ArrayCoder = class extends Coder {
    coder;
    length;
    constructor(coder, length, localName) {
      const type = coder.type + "[" + (length >= 0 ? length : "") + "]";
      const dynamic = length === -1 || coder.dynamic;
      super("array", type, localName, dynamic);
      defineProperties(this, { coder, length });
    }
    defaultValue() {
      const defaultChild = this.coder.defaultValue();
      const result = [];
      for (let i = 0; i < this.length; i++) {
        result.push(defaultChild);
      }
      return result;
    }
    encode(writer, _value) {
      const value = Typed.dereference(_value, "array");
      if (!Array.isArray(value)) {
        this._throwError("expected array value", value);
      }
      let count = this.length;
      if (count === -1) {
        count = value.length;
        writer.writeValue(value.length);
      }
      assertArgumentCount(value.length, count, "coder array" + (this.localName ? " " + this.localName : ""));
      let coders = [];
      for (let i = 0; i < value.length; i++) {
        coders.push(this.coder);
      }
      return pack(writer, coders, value);
    }
    decode(reader) {
      let count = this.length;
      if (count === -1) {
        count = reader.readIndex();
        assert(count * WordSize <= reader.dataLength, "insufficient data length", "BUFFER_OVERRUN", { buffer: reader.bytes, offset: count * WordSize, length: reader.dataLength });
      }
      let coders = [];
      for (let i = 0; i < count; i++) {
        coders.push(new AnonymousCoder(this.coder));
      }
      return unpack(reader, coders);
    }
  };

  // node_modules/ethers/lib.esm/abi/coders/boolean.js
  var BooleanCoder = class extends Coder {
    constructor(localName) {
      super("bool", "bool", localName, false);
    }
    defaultValue() {
      return false;
    }
    encode(writer, _value) {
      const value = Typed.dereference(_value, "bool");
      return writer.writeValue(value ? 1 : 0);
    }
    decode(reader) {
      return !!reader.readValue();
    }
  };

  // node_modules/ethers/lib.esm/abi/coders/bytes.js
  var DynamicBytesCoder = class extends Coder {
    constructor(type, localName) {
      super(type, type, localName, true);
    }
    defaultValue() {
      return "0x";
    }
    encode(writer, value) {
      value = getBytesCopy(value);
      let length = writer.writeValue(value.length);
      length += writer.writeBytes(value);
      return length;
    }
    decode(reader) {
      return reader.readBytes(reader.readIndex(), true);
    }
  };
  var BytesCoder = class extends DynamicBytesCoder {
    constructor(localName) {
      super("bytes", localName);
    }
    decode(reader) {
      return hexlify(super.decode(reader));
    }
  };

  // node_modules/ethers/lib.esm/abi/coders/fixed-bytes.js
  var FixedBytesCoder = class extends Coder {
    size;
    constructor(size, localName) {
      let name = "bytes" + String(size);
      super(name, name, localName, false);
      defineProperties(this, { size }, { size: "number" });
    }
    defaultValue() {
      return "0x0000000000000000000000000000000000000000000000000000000000000000".substring(0, 2 + this.size * 2);
    }
    encode(writer, _value) {
      let data = getBytesCopy(Typed.dereference(_value, this.type));
      if (data.length !== this.size) {
        this._throwError("incorrect data length", _value);
      }
      return writer.writeBytes(data);
    }
    decode(reader) {
      return hexlify(reader.readBytes(this.size));
    }
  };

  // node_modules/ethers/lib.esm/abi/coders/null.js
  var Empty = new Uint8Array([]);
  var NullCoder = class extends Coder {
    constructor(localName) {
      super("null", "", localName, false);
    }
    defaultValue() {
      return null;
    }
    encode(writer, value) {
      if (value != null) {
        this._throwError("not null", value);
      }
      return writer.writeBytes(Empty);
    }
    decode(reader) {
      reader.readBytes(0);
      return null;
    }
  };

  // node_modules/ethers/lib.esm/abi/coders/number.js
  var BN_04 = BigInt(0);
  var BN_13 = BigInt(1);
  var BN_MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  var NumberCoder = class extends Coder {
    size;
    signed;
    constructor(size, signed, localName) {
      const name = (signed ? "int" : "uint") + size * 8;
      super(name, name, localName, false);
      defineProperties(this, { size, signed }, { size: "number", signed: "boolean" });
    }
    defaultValue() {
      return 0;
    }
    encode(writer, _value) {
      let value = getBigInt(Typed.dereference(_value, this.type));
      let maxUintValue = mask(BN_MAX_UINT256, WordSize * 8);
      if (this.signed) {
        let bounds = mask(maxUintValue, this.size * 8 - 1);
        if (value > bounds || value < -(bounds + BN_13)) {
          this._throwError("value out-of-bounds", _value);
        }
        value = toTwos(value, 8 * WordSize);
      } else if (value < BN_04 || value > mask(maxUintValue, this.size * 8)) {
        this._throwError("value out-of-bounds", _value);
      }
      return writer.writeValue(value);
    }
    decode(reader) {
      let value = mask(reader.readValue(), this.size * 8);
      if (this.signed) {
        value = fromTwos(value, this.size * 8);
      }
      return value;
    }
  };

  // node_modules/ethers/lib.esm/abi/coders/string.js
  var StringCoder = class extends DynamicBytesCoder {
    constructor(localName) {
      super("string", localName);
    }
    defaultValue() {
      return "";
    }
    encode(writer, _value) {
      return super.encode(writer, toUtf8Bytes(Typed.dereference(_value, "string")));
    }
    decode(reader) {
      return toUtf8String(super.decode(reader));
    }
  };

  // node_modules/ethers/lib.esm/abi/coders/tuple.js
  var TupleCoder = class extends Coder {
    coders;
    constructor(coders, localName) {
      let dynamic = false;
      const types = [];
      coders.forEach((coder) => {
        if (coder.dynamic) {
          dynamic = true;
        }
        types.push(coder.type);
      });
      const type = "tuple(" + types.join(",") + ")";
      super("tuple", type, localName, dynamic);
      defineProperties(this, { coders: Object.freeze(coders.slice()) });
    }
    defaultValue() {
      const values = [];
      this.coders.forEach((coder) => {
        values.push(coder.defaultValue());
      });
      const uniqueNames = this.coders.reduce((accum, coder) => {
        const name = coder.localName;
        if (name) {
          if (!accum[name]) {
            accum[name] = 0;
          }
          accum[name]++;
        }
        return accum;
      }, {});
      this.coders.forEach((coder, index) => {
        let name = coder.localName;
        if (!name || uniqueNames[name] !== 1) {
          return;
        }
        if (name === "length") {
          name = "_length";
        }
        if (values[name] != null) {
          return;
        }
        values[name] = values[index];
      });
      return Object.freeze(values);
    }
    encode(writer, _value) {
      const value = Typed.dereference(_value, "tuple");
      return pack(writer, this.coders, value);
    }
    decode(reader) {
      return unpack(reader, this.coders);
    }
  };

  // node_modules/ethers/lib.esm/transaction/address.js
  function computeAddress(key) {
    let pubkey;
    if (typeof key === "string") {
      pubkey = SigningKey.computePublicKey(key, false);
    } else {
      pubkey = key.publicKey;
    }
    return getAddress(keccak256("0x" + pubkey.substring(4)).substring(26));
  }
  function recoverAddress(digest, signature) {
    return computeAddress(SigningKey.recoverPublicKey(digest, signature));
  }

  // node_modules/ethers/lib.esm/hash/message.js
  function hashMessage(message) {
    if (typeof message === "string") {
      message = toUtf8Bytes(message);
    }
    return keccak256(concat([
      toUtf8Bytes(MessagePrefix),
      toUtf8Bytes(String(message.length)),
      message
    ]));
  }

  // node_modules/ethers/lib.esm/abi/fragments.js
  function setify(items) {
    const result = /* @__PURE__ */ new Set();
    items.forEach((k) => result.add(k));
    return Object.freeze(result);
  }
  var _kwVisibDeploy = "external public payable override";
  var KwVisibDeploy = setify(_kwVisibDeploy.split(" "));
  var _kwVisib = "constant external internal payable private public pure view override";
  var KwVisib = setify(_kwVisib.split(" "));
  var _kwTypes = "constructor error event fallback function receive struct";
  var KwTypes = setify(_kwTypes.split(" "));
  var _kwModifiers = "calldata memory storage payable indexed";
  var KwModifiers = setify(_kwModifiers.split(" "));
  var _kwOther = "tuple returns";
  var _keywords = [_kwTypes, _kwModifiers, _kwOther, _kwVisib].join(" ");
  var Keywords = setify(_keywords.split(" "));
  var SimpleTokens = {
    "(": "OPEN_PAREN",
    ")": "CLOSE_PAREN",
    "[": "OPEN_BRACKET",
    "]": "CLOSE_BRACKET",
    ",": "COMMA",
    "@": "AT"
  };
  var regexWhitespacePrefix = new RegExp("^(\\s*)");
  var regexNumberPrefix = new RegExp("^([0-9]+)");
  var regexIdPrefix = new RegExp("^([a-zA-Z$_][a-zA-Z0-9$_]*)");
  var regexId = new RegExp("^([a-zA-Z$_][a-zA-Z0-9$_]*)$");
  var regexType = new RegExp("^(address|bool|bytes([0-9]*)|string|u?int([0-9]*))$");
  var TokenString = class _TokenString {
    #offset;
    #tokens;
    get offset() {
      return this.#offset;
    }
    get length() {
      return this.#tokens.length - this.#offset;
    }
    constructor(tokens) {
      this.#offset = 0;
      this.#tokens = tokens.slice();
    }
    clone() {
      return new _TokenString(this.#tokens);
    }
    reset() {
      this.#offset = 0;
    }
    #subTokenString(from = 0, to = 0) {
      return new _TokenString(this.#tokens.slice(from, to).map((t) => {
        return Object.freeze(Object.assign({}, t, {
          match: t.match - from,
          linkBack: t.linkBack - from,
          linkNext: t.linkNext - from
        }));
      }));
    }
    // Pops and returns the value of the next token, if it is a keyword in allowed; throws if out of tokens
    popKeyword(allowed) {
      const top = this.peek();
      if (top.type !== "KEYWORD" || !allowed.has(top.text)) {
        throw new Error(`expected keyword ${top.text}`);
      }
      return this.pop().text;
    }
    // Pops and returns the value of the next token if it is `type`; throws if out of tokens
    popType(type) {
      if (this.peek().type !== type) {
        const top = this.peek();
        throw new Error(`expected ${type}; got ${top.type} ${JSON.stringify(top.text)}`);
      }
      return this.pop().text;
    }
    // Pops and returns a "(" TOKENS ")"
    popParen() {
      const top = this.peek();
      if (top.type !== "OPEN_PAREN") {
        throw new Error("bad start");
      }
      const result = this.#subTokenString(this.#offset + 1, top.match + 1);
      this.#offset = top.match + 1;
      return result;
    }
    // Pops and returns the items within "(" ITEM1 "," ITEM2 "," ... ")"
    popParams() {
      const top = this.peek();
      if (top.type !== "OPEN_PAREN") {
        throw new Error("bad start");
      }
      const result = [];
      while (this.#offset < top.match - 1) {
        const link = this.peek().linkNext;
        result.push(this.#subTokenString(this.#offset + 1, link));
        this.#offset = link;
      }
      this.#offset = top.match + 1;
      return result;
    }
    // Returns the top Token, throwing if out of tokens
    peek() {
      if (this.#offset >= this.#tokens.length) {
        throw new Error("out-of-bounds");
      }
      return this.#tokens[this.#offset];
    }
    // Returns the next value, if it is a keyword in `allowed`
    peekKeyword(allowed) {
      const top = this.peekType("KEYWORD");
      return top != null && allowed.has(top) ? top : null;
    }
    // Returns the value of the next token if it is `type`
    peekType(type) {
      if (this.length === 0) {
        return null;
      }
      const top = this.peek();
      return top.type === type ? top.text : null;
    }
    // Returns the next token; throws if out of tokens
    pop() {
      const result = this.peek();
      this.#offset++;
      return result;
    }
    toString() {
      const tokens = [];
      for (let i = this.#offset; i < this.#tokens.length; i++) {
        const token = this.#tokens[i];
        tokens.push(`${token.type}:${token.text}`);
      }
      return `<TokenString ${tokens.join(" ")}>`;
    }
  };
  function lex(text) {
    const tokens = [];
    const throwError2 = (message) => {
      const token = offset < text.length ? JSON.stringify(text[offset]) : "$EOI";
      throw new Error(`invalid token ${token} at ${offset}: ${message}`);
    };
    let brackets = [];
    let commas = [];
    let offset = 0;
    while (offset < text.length) {
      let cur = text.substring(offset);
      let match = cur.match(regexWhitespacePrefix);
      if (match) {
        offset += match[1].length;
        cur = text.substring(offset);
      }
      const token = { depth: brackets.length, linkBack: -1, linkNext: -1, match: -1, type: "", text: "", offset, value: -1 };
      tokens.push(token);
      let type = SimpleTokens[cur[0]] || "";
      if (type) {
        token.type = type;
        token.text = cur[0];
        offset++;
        if (type === "OPEN_PAREN") {
          brackets.push(tokens.length - 1);
          commas.push(tokens.length - 1);
        } else if (type == "CLOSE_PAREN") {
          if (brackets.length === 0) {
            throwError2("no matching open bracket");
          }
          token.match = brackets.pop();
          tokens[token.match].match = tokens.length - 1;
          token.depth--;
          token.linkBack = commas.pop();
          tokens[token.linkBack].linkNext = tokens.length - 1;
        } else if (type === "COMMA") {
          token.linkBack = commas.pop();
          tokens[token.linkBack].linkNext = tokens.length - 1;
          commas.push(tokens.length - 1);
        } else if (type === "OPEN_BRACKET") {
          token.type = "BRACKET";
        } else if (type === "CLOSE_BRACKET") {
          let suffix = tokens.pop().text;
          if (tokens.length > 0 && tokens[tokens.length - 1].type === "NUMBER") {
            const value = tokens.pop().text;
            suffix = value + suffix;
            tokens[tokens.length - 1].value = getNumber(value);
          }
          if (tokens.length === 0 || tokens[tokens.length - 1].type !== "BRACKET") {
            throw new Error("missing opening bracket");
          }
          tokens[tokens.length - 1].text += suffix;
        }
        continue;
      }
      match = cur.match(regexIdPrefix);
      if (match) {
        token.text = match[1];
        offset += token.text.length;
        if (Keywords.has(token.text)) {
          token.type = "KEYWORD";
          continue;
        }
        if (token.text.match(regexType)) {
          token.type = "TYPE";
          continue;
        }
        token.type = "ID";
        continue;
      }
      match = cur.match(regexNumberPrefix);
      if (match) {
        token.text = match[1];
        token.type = "NUMBER";
        offset += token.text.length;
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(cur[0])} at position ${offset}`);
    }
    return new TokenString(tokens.map((t) => Object.freeze(t)));
  }
  function consumeKeywords(tokens, allowed) {
    const keywords = /* @__PURE__ */ new Set();
    while (true) {
      const keyword = tokens.peekType("KEYWORD");
      if (keyword == null || allowed && !allowed.has(keyword)) {
        break;
      }
      tokens.pop();
      if (keywords.has(keyword)) {
        throw new Error(`duplicate keywords: ${JSON.stringify(keyword)}`);
      }
      keywords.add(keyword);
    }
    return Object.freeze(keywords);
  }
  var regexArrayType = new RegExp(/^(.*)\[([0-9]*)\]$/);
  function verifyBasicType(type) {
    const match = type.match(regexType);
    assertArgument(match, "invalid type", "type", type);
    if (type === "uint") {
      return "uint256";
    }
    if (type === "int") {
      return "int256";
    }
    if (match[2]) {
      const length = parseInt(match[2]);
      assertArgument(length !== 0 && length <= 32, "invalid bytes length", "type", type);
    } else if (match[3]) {
      const size = parseInt(match[3]);
      assertArgument(size !== 0 && size <= 256 && size % 8 === 0, "invalid numeric width", "type", type);
    }
    return type;
  }
  var _guard3 = {};
  var internal = /* @__PURE__ */ Symbol.for("_ethers_internal");
  var ParamTypeInternal = "_ParamTypeInternal";
  var ParamType = class _ParamType {
    /**
     *  The local name of the parameter (or ``""`` if unbound)
     */
    name;
    /**
     *  The fully qualified type (e.g. ``"address"``, ``"tuple(address)"``,
     *  ``"uint256[3][]"``)
     */
    type;
    /**
     *  The base type (e.g. ``"address"``, ``"tuple"``, ``"array"``)
     */
    baseType;
    /**
     *  True if the parameters is indexed.
     *
     *  For non-indexable types this is ``null``.
     */
    indexed;
    /**
     *  The components for the tuple.
     *
     *  For non-tuple types this is ``null``.
     */
    components;
    /**
     *  The array length, or ``-1`` for dynamic-lengthed arrays.
     *
     *  For non-array types this is ``null``.
     */
    arrayLength;
    /**
     *  The type of each child in the array.
     *
     *  For non-array types this is ``null``.
     */
    arrayChildren;
    /**
     *  @private
     */
    constructor(guard, name, type, baseType, indexed, components, arrayLength, arrayChildren) {
      assertPrivate(guard, _guard3, "ParamType");
      Object.defineProperty(this, internal, { value: ParamTypeInternal });
      if (components) {
        components = Object.freeze(components.slice());
      }
      if (baseType === "array") {
        if (arrayLength == null || arrayChildren == null) {
          throw new Error("");
        }
      } else if (arrayLength != null || arrayChildren != null) {
        throw new Error("");
      }
      if (baseType === "tuple") {
        if (components == null) {
          throw new Error("");
        }
      } else if (components != null) {
        throw new Error("");
      }
      defineProperties(this, {
        name,
        type,
        baseType,
        indexed,
        components,
        arrayLength,
        arrayChildren
      });
    }
    /**
     *  Return a string representation of this type.
     *
     *  For example,
     *
     *  ``sighash" => "(uint256,address)"``
     *
     *  ``"minimal" => "tuple(uint256,address) indexed"``
     *
     *  ``"full" => "tuple(uint256 foo, address bar) indexed baz"``
     */
    format(format) {
      if (format == null) {
        format = "sighash";
      }
      if (format === "json") {
        const name = this.name || "";
        if (this.isArray()) {
          const result3 = JSON.parse(this.arrayChildren.format("json"));
          result3.name = name;
          result3.type += `[${this.arrayLength < 0 ? "" : String(this.arrayLength)}]`;
          return JSON.stringify(result3);
        }
        const result2 = {
          type: this.baseType === "tuple" ? "tuple" : this.type,
          name
        };
        if (typeof this.indexed === "boolean") {
          result2.indexed = this.indexed;
        }
        if (this.isTuple()) {
          result2.components = this.components.map((c) => JSON.parse(c.format(format)));
        }
        return JSON.stringify(result2);
      }
      let result = "";
      if (this.isArray()) {
        result += this.arrayChildren.format(format);
        result += `[${this.arrayLength < 0 ? "" : String(this.arrayLength)}]`;
      } else {
        if (this.isTuple()) {
          result += "(" + this.components.map((comp) => comp.format(format)).join(format === "full" ? ", " : ",") + ")";
        } else {
          result += this.type;
        }
      }
      if (format !== "sighash") {
        if (this.indexed === true) {
          result += " indexed";
        }
        if (format === "full" && this.name) {
          result += " " + this.name;
        }
      }
      return result;
    }
    /**
     *  Returns true if %%this%% is an Array type.
     *
     *  This provides a type gaurd ensuring that [[arrayChildren]]
     *  and [[arrayLength]] are non-null.
     */
    isArray() {
      return this.baseType === "array";
    }
    /**
     *  Returns true if %%this%% is a Tuple type.
     *
     *  This provides a type gaurd ensuring that [[components]]
     *  is non-null.
     */
    isTuple() {
      return this.baseType === "tuple";
    }
    /**
     *  Returns true if %%this%% is an Indexable type.
     *
     *  This provides a type gaurd ensuring that [[indexed]]
     *  is non-null.
     */
    isIndexable() {
      return this.indexed != null;
    }
    /**
     *  Walks the **ParamType** with %%value%%, calling %%process%%
     *  on each type, destructing the %%value%% recursively.
     */
    walk(value, process) {
      if (this.isArray()) {
        if (!Array.isArray(value)) {
          throw new Error("invalid array value");
        }
        if (this.arrayLength !== -1 && value.length !== this.arrayLength) {
          throw new Error("array is wrong length");
        }
        const _this = this;
        return value.map((v) => _this.arrayChildren.walk(v, process));
      }
      if (this.isTuple()) {
        if (!Array.isArray(value)) {
          throw new Error("invalid tuple value");
        }
        if (value.length !== this.components.length) {
          throw new Error("array is wrong length");
        }
        const _this = this;
        return value.map((v, i) => _this.components[i].walk(v, process));
      }
      return process(this.type, value);
    }
    #walkAsync(promises, value, process, setValue) {
      if (this.isArray()) {
        if (!Array.isArray(value)) {
          throw new Error("invalid array value");
        }
        if (this.arrayLength !== -1 && value.length !== this.arrayLength) {
          throw new Error("array is wrong length");
        }
        const childType = this.arrayChildren;
        const result2 = value.slice();
        result2.forEach((value2, index) => {
          childType.#walkAsync(promises, value2, process, (value3) => {
            result2[index] = value3;
          });
        });
        setValue(result2);
        return;
      }
      if (this.isTuple()) {
        const components = this.components;
        let result2;
        if (Array.isArray(value)) {
          result2 = value.slice();
        } else {
          if (value == null || typeof value !== "object") {
            throw new Error("invalid tuple value");
          }
          result2 = components.map((param) => {
            if (!param.name) {
              throw new Error("cannot use object value with unnamed components");
            }
            if (!(param.name in value)) {
              throw new Error(`missing value for component ${param.name}`);
            }
            return value[param.name];
          });
        }
        if (result2.length !== this.components.length) {
          throw new Error("array is wrong length");
        }
        result2.forEach((value2, index) => {
          components[index].#walkAsync(promises, value2, process, (value3) => {
            result2[index] = value3;
          });
        });
        setValue(result2);
        return;
      }
      const result = process(this.type, value);
      if (result.then) {
        promises.push((async function() {
          setValue(await result);
        })());
      } else {
        setValue(result);
      }
    }
    /**
     *  Walks the **ParamType** with %%value%%, asynchronously calling
     *  %%process%% on each type, destructing the %%value%% recursively.
     *
     *  This can be used to resolve ENS names by walking and resolving each
     *  ``"address"`` type.
     */
    async walkAsync(value, process) {
      const promises = [];
      const result = [value];
      this.#walkAsync(promises, value, process, (value2) => {
        result[0] = value2;
      });
      if (promises.length) {
        await Promise.all(promises);
      }
      return result[0];
    }
    /**
     *  Creates a new **ParamType** for %%obj%%.
     *
     *  If %%allowIndexed%% then the ``indexed`` keyword is permitted,
     *  otherwise the ``indexed`` keyword will throw an error.
     */
    static from(obj, allowIndexed) {
      if (_ParamType.isParamType(obj)) {
        return obj;
      }
      if (typeof obj === "string") {
        try {
          return _ParamType.from(lex(obj), allowIndexed);
        } catch (error) {
          assertArgument(false, "invalid param type", "obj", obj);
        }
      } else if (obj instanceof TokenString) {
        let type2 = "", baseType = "";
        let comps = null;
        if (consumeKeywords(obj, setify(["tuple"])).has("tuple") || obj.peekType("OPEN_PAREN")) {
          baseType = "tuple";
          comps = obj.popParams().map((t) => _ParamType.from(t));
          type2 = `tuple(${comps.map((c) => c.format()).join(",")})`;
        } else {
          type2 = verifyBasicType(obj.popType("TYPE"));
          baseType = type2;
        }
        let arrayChildren = null;
        let arrayLength = null;
        while (obj.length && obj.peekType("BRACKET")) {
          const bracket = obj.pop();
          arrayChildren = new _ParamType(_guard3, "", type2, baseType, null, comps, arrayLength, arrayChildren);
          arrayLength = bracket.value;
          type2 += bracket.text;
          baseType = "array";
          comps = null;
        }
        let indexed2 = null;
        const keywords = consumeKeywords(obj, KwModifiers);
        if (keywords.has("indexed")) {
          if (!allowIndexed) {
            throw new Error("");
          }
          indexed2 = true;
        }
        const name2 = obj.peekType("ID") ? obj.pop().text : "";
        if (obj.length) {
          throw new Error("leftover tokens");
        }
        return new _ParamType(_guard3, name2, type2, baseType, indexed2, comps, arrayLength, arrayChildren);
      }
      const name = obj.name;
      assertArgument(!name || typeof name === "string" && name.match(regexId), "invalid name", "obj.name", name);
      let indexed = obj.indexed;
      if (indexed != null) {
        assertArgument(allowIndexed, "parameter cannot be indexed", "obj.indexed", obj.indexed);
        indexed = !!indexed;
      }
      let type = obj.type;
      let arrayMatch = type.match(regexArrayType);
      if (arrayMatch) {
        const arrayLength = parseInt(arrayMatch[2] || "-1");
        const arrayChildren = _ParamType.from({
          type: arrayMatch[1],
          components: obj.components
        });
        return new _ParamType(_guard3, name || "", type, "array", indexed, null, arrayLength, arrayChildren);
      }
      if (type === "tuple" || type.startsWith(
        "tuple("
        /* fix: ) */
      ) || type.startsWith(
        "("
        /* fix: ) */
      )) {
        const comps = obj.components != null ? obj.components.map((c) => _ParamType.from(c)) : null;
        const tuple = new _ParamType(_guard3, name || "", type, "tuple", indexed, comps, null, null);
        return tuple;
      }
      type = verifyBasicType(obj.type);
      return new _ParamType(_guard3, name || "", type, type, indexed, null, null, null);
    }
    /**
     *  Returns true if %%value%% is a **ParamType**.
     */
    static isParamType(value) {
      return value && value[internal] === ParamTypeInternal;
    }
  };

  // node_modules/ethers/lib.esm/abi/abi-coder.js
  var PanicReasons = /* @__PURE__ */ new Map();
  PanicReasons.set(0, "GENERIC_PANIC");
  PanicReasons.set(1, "ASSERT_FALSE");
  PanicReasons.set(17, "OVERFLOW");
  PanicReasons.set(18, "DIVIDE_BY_ZERO");
  PanicReasons.set(33, "ENUM_RANGE_ERROR");
  PanicReasons.set(34, "BAD_STORAGE_DATA");
  PanicReasons.set(49, "STACK_UNDERFLOW");
  PanicReasons.set(50, "ARRAY_RANGE_ERROR");
  PanicReasons.set(65, "OUT_OF_MEMORY");
  PanicReasons.set(81, "UNINITIALIZED_FUNCTION_CALL");
  var paramTypeBytes = new RegExp(/^bytes([0-9]*)$/);
  var paramTypeNumber = new RegExp(/^(u?int)([0-9]*)$/);
  var defaultCoder = null;
  var defaultMaxInflation = 1024;
  function getBuiltinCallException(action, tx, data, abiCoder) {
    let message = "missing revert data";
    let reason = null;
    const invocation = null;
    let revert = null;
    if (data) {
      message = "execution reverted";
      const bytes2 = getBytes(data);
      data = hexlify(data);
      if (bytes2.length === 0) {
        message += " (no data present; likely require(false) occurred";
        reason = "require(false)";
      } else if (bytes2.length % 32 !== 4) {
        message += " (could not decode reason; invalid data length)";
      } else if (hexlify(bytes2.slice(0, 4)) === "0x08c379a0") {
        try {
          reason = abiCoder.decode(["string"], bytes2.slice(4))[0];
          revert = {
            signature: "Error(string)",
            name: "Error",
            args: [reason]
          };
          message += `: ${JSON.stringify(reason)}`;
        } catch (error) {
          message += " (could not decode reason; invalid string data)";
        }
      } else if (hexlify(bytes2.slice(0, 4)) === "0x4e487b71") {
        try {
          const code = Number(abiCoder.decode(["uint256"], bytes2.slice(4))[0]);
          revert = {
            signature: "Panic(uint256)",
            name: "Panic",
            args: [code]
          };
          reason = `Panic due to ${PanicReasons.get(code) || "UNKNOWN"}(${code})`;
          message += `: ${reason}`;
        } catch (error) {
          message += " (could not decode panic code)";
        }
      } else {
        message += " (unknown custom error)";
      }
    }
    const transaction = {
      to: tx.to ? getAddress(tx.to) : null,
      data: tx.data || "0x"
    };
    if (tx.from) {
      transaction.from = getAddress(tx.from);
    }
    return makeError(message, "CALL_EXCEPTION", {
      action,
      data,
      reason,
      transaction,
      invocation,
      revert
    });
  }
  var AbiCoder = class _AbiCoder {
    #getCoder(param) {
      if (param.isArray()) {
        return new ArrayCoder(this.#getCoder(param.arrayChildren), param.arrayLength, param.name);
      }
      if (param.isTuple()) {
        return new TupleCoder(param.components.map((c) => this.#getCoder(c)), param.name);
      }
      switch (param.baseType) {
        case "address":
          return new AddressCoder(param.name);
        case "bool":
          return new BooleanCoder(param.name);
        case "string":
          return new StringCoder(param.name);
        case "bytes":
          return new BytesCoder(param.name);
        case "":
          return new NullCoder(param.name);
      }
      let match = param.type.match(paramTypeNumber);
      if (match) {
        let size = parseInt(match[2] || "256");
        assertArgument(size !== 0 && size <= 256 && size % 8 === 0, "invalid " + match[1] + " bit length", "param", param);
        return new NumberCoder(size / 8, match[1] === "int", param.name);
      }
      match = param.type.match(paramTypeBytes);
      if (match) {
        let size = parseInt(match[1]);
        assertArgument(size !== 0 && size <= 32, "invalid bytes length", "param", param);
        return new FixedBytesCoder(size, param.name);
      }
      assertArgument(false, "invalid type", "type", param.type);
    }
    /**
     *  Get the default values for the given %%types%%.
     *
     *  For example, a ``uint`` is by default ``0`` and ``bool``
     *  is by default ``false``.
     */
    getDefaultValue(types) {
      const coders = types.map((type) => this.#getCoder(ParamType.from(type)));
      const coder = new TupleCoder(coders, "_");
      return coder.defaultValue();
    }
    /**
     *  Encode the %%values%% as the %%types%% into ABI data.
     *
     *  @returns DataHexstring
     */
    encode(types, values) {
      assertArgumentCount(values.length, types.length, "types/values length mismatch");
      const coders = types.map((type) => this.#getCoder(ParamType.from(type)));
      const coder = new TupleCoder(coders, "_");
      const writer = new Writer();
      coder.encode(writer, values);
      return writer.data;
    }
    /**
     *  Decode the ABI %%data%% as the %%types%% into values.
     *
     *  If %%loose%% decoding is enabled, then strict padding is
     *  not enforced. Some older versions of Solidity incorrectly
     *  padded event data emitted from ``external`` functions.
     */
    decode(types, data, loose) {
      const coders = types.map((type) => this.#getCoder(ParamType.from(type)));
      const coder = new TupleCoder(coders, "_");
      return coder.decode(new Reader(data, loose, defaultMaxInflation));
    }
    static _setDefaultMaxInflation(value) {
      assertArgument(typeof value === "number" && Number.isInteger(value), "invalid defaultMaxInflation factor", "value", value);
      defaultMaxInflation = value;
    }
    /**
     *  Returns the shared singleton instance of a default [[AbiCoder]].
     *
     *  On the first call, the instance is created internally.
     */
    static defaultAbiCoder() {
      if (defaultCoder == null) {
        defaultCoder = new _AbiCoder();
      }
      return defaultCoder;
    }
    /**
     *  Returns an ethers-compatible [[CallExceptionError]] Error for the given
     *  result %%data%% for the [[CallExceptionAction]] %%action%% against
     *  the Transaction %%tx%%.
     */
    static getBuiltinCallException(action, tx, data) {
      return getBuiltinCallException(action, tx, data, _AbiCoder.defaultAbiCoder());
    }
  };

  // node_modules/@hpke/common/esm/src/errors.js
  var HpkeError = class extends Error {
    constructor(e) {
      let message;
      if (e instanceof Error) {
        message = e.message;
      } else if (typeof e === "string") {
        message = e;
      } else {
        message = "";
      }
      super(message);
      this.name = this.constructor.name;
    }
  };
  var InvalidParamError = class extends HpkeError {
  };
  var SerializeError = class extends HpkeError {
  };
  var DeserializeError = class extends HpkeError {
  };
  var EncapError = class extends HpkeError {
  };
  var DecapError = class extends HpkeError {
  };
  var ExportError = class extends HpkeError {
  };
  var SealError = class extends HpkeError {
  };
  var OpenError = class extends HpkeError {
  };
  var MessageLimitReachedError = class extends HpkeError {
  };
  var DeriveKeyPairError = class extends HpkeError {
  };
  var NotSupportedError = class extends HpkeError {
  };

  // node_modules/@hpke/common/esm/_dnt.shims.js
  var dntGlobals = {};
  var dntGlobalThis = createMergeProxy(globalThis, dntGlobals);
  function createMergeProxy(baseObj, extObj) {
    return new Proxy(baseObj, {
      get(_target, prop, _receiver) {
        if (prop in extObj) {
          return extObj[prop];
        } else {
          return baseObj[prop];
        }
      },
      set(_target, prop, value) {
        if (prop in extObj) {
          delete extObj[prop];
        }
        baseObj[prop] = value;
        return true;
      },
      deleteProperty(_target, prop) {
        let success = false;
        if (prop in extObj) {
          delete extObj[prop];
          success = true;
        }
        if (prop in baseObj) {
          delete baseObj[prop];
          success = true;
        }
        return success;
      },
      ownKeys(_target) {
        const baseKeys = Reflect.ownKeys(baseObj);
        const extKeys = Reflect.ownKeys(extObj);
        const extKeysSet = new Set(extKeys);
        return [...baseKeys.filter((k) => !extKeysSet.has(k)), ...extKeys];
      },
      defineProperty(_target, prop, desc) {
        if (prop in extObj) {
          delete extObj[prop];
        }
        Reflect.defineProperty(baseObj, prop, desc);
        return true;
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (prop in extObj) {
          return Reflect.getOwnPropertyDescriptor(extObj, prop);
        } else {
          return Reflect.getOwnPropertyDescriptor(baseObj, prop);
        }
      },
      has(_target, prop) {
        return prop in extObj || prop in baseObj;
      }
    });
  }

  // node_modules/@hpke/common/esm/src/algorithm.js
  async function loadSubtleCrypto() {
    if (dntGlobalThis !== void 0 && globalThis.crypto !== void 0) {
      return globalThis.crypto.subtle;
    }
    try {
      const { webcrypto } = await import("crypto");
      return webcrypto.subtle;
    } catch (e) {
      throw new NotSupportedError(e);
    }
  }
  var NativeAlgorithm = class {
    constructor() {
      Object.defineProperty(this, "_api", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
    }
    async _setup() {
      if (this._api !== void 0) {
        return;
      }
      this._api = await loadSubtleCrypto();
    }
  };

  // node_modules/@hpke/common/esm/src/identifiers.js
  var Mode = {
    Base: 0,
    Psk: 1,
    Auth: 2,
    AuthPsk: 3
  };
  var KemId = {
    NotAssigned: 0,
    DhkemP256HkdfSha256: 16,
    DhkemP384HkdfSha384: 17,
    DhkemP521HkdfSha512: 18,
    DhkemSecp256k1HkdfSha256: 19,
    DhkemX25519HkdfSha256: 32,
    DhkemX448HkdfSha512: 33,
    HybridkemX25519Kyber768: 48,
    MlKem512: 64,
    MlKem768: 65,
    MlKem1024: 66,
    XWing: 25722
  };
  var KdfId = {
    HkdfSha256: 1,
    HkdfSha384: 2,
    HkdfSha512: 3,
    Sha3256: 4,
    Sha3384: 5,
    Sha3512: 6,
    Shake128: 16,
    Shake256: 17,
    TurboShake128: 18,
    TurboShake256: 19
  };
  var AeadId = {
    Aes128Gcm: 1,
    Aes256Gcm: 2,
    Chacha20Poly1305: 3,
    ExportOnly: 65535
  };

  // node_modules/@hpke/common/esm/src/consts.js
  var INPUT_LENGTH_LIMIT = 8192;
  var INFO_LENGTH_LIMIT = 268435456;
  var MINIMUM_PSK_LENGTH = 32;
  var EMPTY = /* @__PURE__ */ new Uint8Array(0);
  var N_0 = 0n;
  var N_1 = 1n;
  var N_2 = 2n;
  var BYTE_TO_BIGINT_256 = /* @__PURE__ */ (() => {
    const out = new Array(256);
    let i = 0;
    let value = 0n;
    while (i < 256) {
      out[i] = value;
      i++;
      value += 1n;
    }
    return out;
  })();

  // node_modules/@hpke/common/esm/src/interfaces/kemInterface.js
  var SUITE_ID_HEADER_KEM = /* @__PURE__ */ new Uint8Array([
    75,
    69,
    77,
    0,
    0
  ]);

  // node_modules/@hpke/common/esm/src/kdfs/hkdf.js
  var HPKE_VERSION = /* @__PURE__ */ new Uint8Array([
    72,
    80,
    75,
    69,
    45,
    118,
    49
  ]);
  function toUint8Array(input) {
    return new Uint8Array(toArrayBuffer(input));
  }
  function toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) {
      return input;
    }
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice().buffer;
    }
    return new Uint8Array(input).slice().buffer;
  }
  var HkdfNative = class extends NativeAlgorithm {
    constructor() {
      super();
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: KdfId.HkdfSha256
      });
      Object.defineProperty(this, "hashSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0
      });
      Object.defineProperty(this, "_suiteId", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: EMPTY
      });
      Object.defineProperty(this, "algHash", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: {
          name: "HMAC",
          hash: "SHA-256",
          length: 256
        }
      });
    }
    init(suiteId) {
      this._suiteId = suiteId;
    }
    buildLabeledIkm(label, ikm) {
      this._checkInit();
      const ret = new Uint8Array(7 + this._suiteId.byteLength + label.byteLength + ikm.byteLength);
      ret.set(HPKE_VERSION, 0);
      ret.set(this._suiteId, 7);
      ret.set(label, 7 + this._suiteId.byteLength);
      ret.set(ikm, 7 + this._suiteId.byteLength + label.byteLength);
      return ret;
    }
    buildLabeledInfo(label, info, len) {
      this._checkInit();
      const ret = new Uint8Array(9 + this._suiteId.byteLength + label.byteLength + info.byteLength);
      ret.set(new Uint8Array([0, len]), 0);
      ret.set(HPKE_VERSION, 2);
      ret.set(this._suiteId, 9);
      ret.set(label, 9 + this._suiteId.byteLength);
      ret.set(info, 9 + this._suiteId.byteLength + label.byteLength);
      return ret;
    }
    async extract(salt, ikm) {
      await this._setup();
      const saltBuf = salt.byteLength === 0 ? new ArrayBuffer(this.hashSize) : toArrayBuffer(salt);
      if (saltBuf.byteLength !== this.hashSize) {
        throw new InvalidParamError("The salt length must be the same as the hashSize");
      }
      const ikmBuf = toArrayBuffer(ikm);
      const key = await this._api.importKey("raw", saltBuf, this.algHash, false, [
        "sign"
      ]);
      return await this._api.sign("HMAC", key, ikmBuf);
    }
    async expand(prk, info, len) {
      await this._setup();
      const prkBuf = toArrayBuffer(prk);
      const key = await this._api.importKey("raw", prkBuf, this.algHash, false, [
        "sign"
      ]);
      const okm = new ArrayBuffer(len);
      const okmBytes = new Uint8Array(okm);
      let prev = EMPTY;
      const mid = toUint8Array(info);
      const tail = new Uint8Array(1);
      if (len > 255 * this.hashSize) {
        throw new Error("Entropy limit reached");
      }
      const tmp = new Uint8Array(this.hashSize + mid.length + 1);
      for (let i = 1, cur = 0; cur < okmBytes.length; i++) {
        tail[0] = i;
        tmp.set(prev, 0);
        tmp.set(mid, prev.length);
        tmp.set(tail, prev.length + mid.length);
        prev = new Uint8Array(await this._api.sign("HMAC", key, tmp.slice(0, prev.length + mid.length + 1)));
        if (okmBytes.length - cur >= prev.length) {
          okmBytes.set(prev, cur);
          cur += prev.length;
        } else {
          okmBytes.set(prev.slice(0, okmBytes.length - cur), cur);
          cur += okmBytes.length - cur;
        }
      }
      return okm;
    }
    async extractAndExpand(salt, ikm, info, len) {
      await this._setup();
      const ikmBuf = toArrayBuffer(ikm);
      const baseKey = await this._api.importKey("raw", ikmBuf, "HKDF", false, ["deriveBits"]);
      return await this._api.deriveBits({
        name: "HKDF",
        hash: this.algHash.hash,
        salt: toArrayBuffer(salt),
        info: toArrayBuffer(info)
      }, baseKey, len * 8);
    }
    async labeledExtract(salt, label, ikm) {
      return await this.extract(salt, this.buildLabeledIkm(label, ikm));
    }
    async labeledExpand(prk, label, info, len) {
      return await this.expand(prk, this.buildLabeledInfo(label, info, len), len);
    }
    _checkInit() {
      if (this._suiteId === EMPTY) {
        throw new Error("Not initialized. Call init()");
      }
    }
  };
  var HkdfSha256Native = class extends HkdfNative {
    constructor() {
      super(...arguments);
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: KdfId.HkdfSha256
      });
      Object.defineProperty(this, "hashSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32
      });
      Object.defineProperty(this, "algHash", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: {
          name: "HMAC",
          hash: "SHA-256",
          length: 256
        }
      });
    }
  };
  var HkdfSha384Native = class extends HkdfNative {
    constructor() {
      super(...arguments);
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: KdfId.HkdfSha384
      });
      Object.defineProperty(this, "hashSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 48
      });
      Object.defineProperty(this, "algHash", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: {
          name: "HMAC",
          hash: "SHA-384",
          length: 384
        }
      });
    }
  };
  var HkdfSha512Native = class extends HkdfNative {
    constructor() {
      super(...arguments);
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: KdfId.HkdfSha512
      });
      Object.defineProperty(this, "hashSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 64
      });
      Object.defineProperty(this, "algHash", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: {
          name: "HMAC",
          hash: "SHA-512",
          length: 512
        }
      });
    }
  };

  // node_modules/@hpke/common/esm/src/utils/misc.js
  var isCryptoKeyPair = (x) => typeof x === "object" && x !== null && typeof x.privateKey === "object" && typeof x.publicKey === "object";
  function i2Osp(n2, w) {
    if (w <= 0) {
      throw new Error("i2Osp: too small size");
    }
    if (n2 >= 256 ** w) {
      throw new Error("i2Osp: too large integer");
    }
    const ret = new Uint8Array(w);
    for (let i = 0; i < w && n2; i++) {
      ret[w - (i + 1)] = n2 % 256;
      n2 = Math.floor(n2 / 256);
    }
    return ret;
  }
  function concat2(a, b2) {
    const ret = new Uint8Array(a.length + b2.length);
    ret.set(a, 0);
    ret.set(b2, a.length);
    return ret;
  }
  function base64UrlToBytes(v) {
    const base64 = v.replace(/-/g, "+").replace(/_/g, "/");
    const byteString = atob(base64);
    const ret = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) {
      ret[i] = byteString.charCodeAt(i);
    }
    return ret;
  }
  async function loadCrypto() {
    if (typeof dntGlobalThis !== "undefined" && globalThis.crypto !== void 0) {
      return globalThis.crypto;
    }
    try {
      const { webcrypto } = await import("crypto");
      return webcrypto;
    } catch (_e) {
      throw new Error("failed to load Crypto");
    }
  }
  function xor(a, b2) {
    if (a.byteLength !== b2.byteLength) {
      throw new Error("xor: different length inputs");
    }
    const buf = new Uint8Array(a.byteLength);
    for (let i = 0; i < a.byteLength; i++) {
      buf[i] = a[i] ^ b2[i];
    }
    return buf;
  }

  // node_modules/@hpke/common/esm/src/kems/dhkem.js
  var LABEL_EAE_PRK = /* @__PURE__ */ new Uint8Array([
    101,
    97,
    101,
    95,
    112,
    114,
    107
  ]);
  var LABEL_SHARED_SECRET = /* @__PURE__ */ new Uint8Array([
    115,
    104,
    97,
    114,
    101,
    100,
    95,
    115,
    101,
    99,
    114,
    101,
    116
  ]);
  function concat3(a, b2, c) {
    const ret = new Uint8Array(a.length + b2.length + c.length);
    ret.set(a, 0);
    ret.set(b2, a.length);
    ret.set(c, a.length + b2.length);
    return ret;
  }
  var Dhkem = class {
    constructor(id2, prim, kdf) {
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "secretSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0
      });
      Object.defineProperty(this, "encSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0
      });
      Object.defineProperty(this, "publicKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0
      });
      Object.defineProperty(this, "privateKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0
      });
      Object.defineProperty(this, "_prim", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_kdf", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this.id = id2;
      this._prim = prim;
      this._kdf = kdf;
      const suiteId = new Uint8Array(SUITE_ID_HEADER_KEM);
      suiteId.set(i2Osp(this.id, 2), 3);
      this._kdf.init(suiteId);
    }
    async serializePublicKey(key) {
      return await this._prim.serializePublicKey(key);
    }
    async deserializePublicKey(key) {
      return await this._prim.deserializePublicKey(toArrayBuffer(key));
    }
    async serializePrivateKey(key) {
      return await this._prim.serializePrivateKey(key);
    }
    async deserializePrivateKey(key) {
      return await this._prim.deserializePrivateKey(toArrayBuffer(key));
    }
    async importKey(format, key, isPublic = true) {
      return await this._prim.importKey(format, key, isPublic);
    }
    async generateKeyPair() {
      return await this._prim.generateKeyPair();
    }
    async deriveKeyPair(ikm) {
      const rawIkm = toArrayBuffer(ikm);
      if (rawIkm.byteLength > INPUT_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long ikm");
      }
      return await this._prim.deriveKeyPair(rawIkm);
    }
    async encap(params) {
      let ke;
      if (params.ekm === void 0) {
        ke = await this.generateKeyPair();
      } else if (isCryptoKeyPair(params.ekm)) {
        ke = params.ekm;
      } else {
        ke = await this.deriveKeyPair(params.ekm);
      }
      const enc = await this._prim.serializePublicKey(ke.publicKey);
      const pkrm = await this._prim.serializePublicKey(params.recipientPublicKey);
      try {
        let dh;
        if (params.senderKey === void 0) {
          dh = new Uint8Array(await this._prim.dh(ke.privateKey, params.recipientPublicKey));
        } else {
          const sks = isCryptoKeyPair(params.senderKey) ? params.senderKey.privateKey : params.senderKey;
          const dh1 = new Uint8Array(await this._prim.dh(ke.privateKey, params.recipientPublicKey));
          const dh2 = new Uint8Array(await this._prim.dh(sks, params.recipientPublicKey));
          dh = concat2(dh1, dh2);
        }
        let kemContext;
        if (params.senderKey === void 0) {
          kemContext = concat2(new Uint8Array(enc), new Uint8Array(pkrm));
        } else {
          const pks = isCryptoKeyPair(params.senderKey) ? params.senderKey.publicKey : await this._prim.derivePublicKey(params.senderKey);
          const pksm = await this._prim.serializePublicKey(pks);
          kemContext = concat3(new Uint8Array(enc), new Uint8Array(pkrm), new Uint8Array(pksm));
        }
        const sharedSecret = await this._generateSharedSecret(dh, kemContext);
        return {
          enc,
          sharedSecret
        };
      } catch (e) {
        throw new EncapError(e);
      }
    }
    async decap(params) {
      const enc = toArrayBuffer(params.enc);
      const pke = await this._prim.deserializePublicKey(enc);
      const skr = isCryptoKeyPair(params.recipientKey) ? params.recipientKey.privateKey : params.recipientKey;
      const pkr = isCryptoKeyPair(params.recipientKey) ? params.recipientKey.publicKey : await this._prim.derivePublicKey(params.recipientKey);
      const pkrm = await this._prim.serializePublicKey(pkr);
      try {
        let dh;
        if (params.senderPublicKey === void 0) {
          dh = new Uint8Array(await this._prim.dh(skr, pke));
        } else {
          const dh1 = new Uint8Array(await this._prim.dh(skr, pke));
          const dh2 = new Uint8Array(await this._prim.dh(skr, params.senderPublicKey));
          dh = concat2(dh1, dh2);
        }
        let kemContext;
        if (params.senderPublicKey === void 0) {
          kemContext = concat2(new Uint8Array(enc), new Uint8Array(pkrm));
        } else {
          const pksm = await this._prim.serializePublicKey(params.senderPublicKey);
          kemContext = new Uint8Array(enc.byteLength + pkrm.byteLength + pksm.byteLength);
          kemContext.set(new Uint8Array(enc), 0);
          kemContext.set(new Uint8Array(pkrm), enc.byteLength);
          kemContext.set(new Uint8Array(pksm), enc.byteLength + pkrm.byteLength);
        }
        return await this._generateSharedSecret(dh, kemContext);
      } catch (e) {
        throw new DecapError(e);
      }
    }
    async _generateSharedSecret(dh, kemContext) {
      const labeledIkm = this._kdf.buildLabeledIkm(LABEL_EAE_PRK, dh);
      const labeledInfo = this._kdf.buildLabeledInfo(LABEL_SHARED_SECRET, kemContext, this.secretSize);
      return await this._kdf.extractAndExpand(EMPTY, labeledIkm, labeledInfo, this.secretSize);
    }
  };

  // node_modules/@hpke/common/esm/src/interfaces/dhkemPrimitives.js
  var KEM_USAGES = ["deriveBits"];
  var LABEL_DKP_PRK = /* @__PURE__ */ new Uint8Array([
    100,
    107,
    112,
    95,
    112,
    114,
    107
  ]);
  var LABEL_SK = /* @__PURE__ */ new Uint8Array([115, 107]);

  // node_modules/@hpke/common/esm/src/utils/bignum.js
  var Bignum = class {
    constructor(size) {
      Object.defineProperty(this, "_num", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this._num = new Uint8Array(size);
    }
    val() {
      return this._num;
    }
    reset() {
      this._num.fill(0);
    }
    set(src) {
      if (src.length !== this._num.length) {
        throw new Error("Bignum.set: invalid argument");
      }
      this._num.set(src);
    }
    isZero() {
      for (let i = 0; i < this._num.length; i++) {
        if (this._num[i] !== 0) {
          return false;
        }
      }
      return true;
    }
    lessThan(v) {
      if (v.length !== this._num.length) {
        throw new Error("Bignum.lessThan: invalid argument");
      }
      for (let i = 0; i < this._num.length; i++) {
        if (this._num[i] < v[i]) {
          return true;
        }
        if (this._num[i] > v[i]) {
          return false;
        }
      }
      return false;
    }
  };

  // node_modules/@hpke/common/esm/src/kems/dhkemPrimitives/ec.js
  var LABEL_CANDIDATE = /* @__PURE__ */ new Uint8Array([
    99,
    97,
    110,
    100,
    105,
    100,
    97,
    116,
    101
  ]);
  var ORDER_P_256 = /* @__PURE__ */ new Uint8Array([
    255,
    255,
    255,
    255,
    0,
    0,
    0,
    0,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    188,
    230,
    250,
    173,
    167,
    23,
    158,
    132,
    243,
    185,
    202,
    194,
    252,
    99,
    37,
    81
  ]);
  var ORDER_P_384 = /* @__PURE__ */ new Uint8Array([
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    199,
    99,
    77,
    129,
    244,
    55,
    45,
    223,
    88,
    26,
    13,
    178,
    72,
    176,
    167,
    122,
    236,
    236,
    25,
    106,
    204,
    197,
    41,
    115
  ]);
  var ORDER_P_521 = /* @__PURE__ */ new Uint8Array([
    1,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    250,
    81,
    134,
    135,
    131,
    191,
    47,
    150,
    107,
    127,
    204,
    1,
    72,
    247,
    9,
    165,
    208,
    59,
    181,
    201,
    184,
    137,
    156,
    71,
    174,
    187,
    111,
    183,
    30,
    145,
    56,
    100,
    9
  ]);
  var PKCS8_ALG_ID_P_256 = /* @__PURE__ */ new Uint8Array([
    48,
    65,
    2,
    1,
    0,
    48,
    19,
    6,
    7,
    42,
    134,
    72,
    206,
    61,
    2,
    1,
    6,
    8,
    42,
    134,
    72,
    206,
    61,
    3,
    1,
    7,
    4,
    39,
    48,
    37,
    2,
    1,
    1,
    4,
    32
  ]);
  var PKCS8_ALG_ID_P_384 = /* @__PURE__ */ new Uint8Array([
    48,
    78,
    2,
    1,
    0,
    48,
    16,
    6,
    7,
    42,
    134,
    72,
    206,
    61,
    2,
    1,
    6,
    5,
    43,
    129,
    4,
    0,
    34,
    4,
    55,
    48,
    53,
    2,
    1,
    1,
    4,
    48
  ]);
  var PKCS8_ALG_ID_P_521 = /* @__PURE__ */ new Uint8Array([
    48,
    96,
    2,
    1,
    0,
    48,
    16,
    6,
    7,
    42,
    134,
    72,
    206,
    61,
    2,
    1,
    6,
    5,
    43,
    129,
    4,
    0,
    35,
    4,
    73,
    48,
    71,
    2,
    1,
    1,
    4,
    66
  ]);
  var EC_P_256_PARAMS = {
    p: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn,
    b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
    gx: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
    gy: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
    coordinateSize: 32
  };
  var EC_P_384_PARAMS = {
    p: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffffn,
    b: 0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aefn,
    gx: 0xaa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7n,
    gy: 0x3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5fn,
    coordinateSize: 48
  };
  var EC_P_521_PARAMS = {
    p: (1n << 521n) - 1n,
    b: 0x0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00n,
    gx: 0x00c6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66n,
    gy: 0x011839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650n,
    coordinateSize: 66
  };
  function mod2(a, p) {
    const r = a % p;
    return r >= 0n ? r : r + p;
  }
  function modPow(base, exponent, p) {
    let result = 1n;
    let b2 = mod2(base, p);
    let e = exponent;
    while (e > 0n) {
      if ((e & 1n) === 1n) {
        result = mod2(result * b2, p);
      }
      b2 = mod2(b2 * b2, p);
      e >>= 1n;
    }
    return result;
  }
  function modSqrt(rhs, p) {
    const y = modPow(rhs, p + 1n >> 2n, p);
    if (mod2(y * y, p) !== mod2(rhs, p)) {
      throw new Error("Invalid ECDH point");
    }
    return y;
  }
  function bytesToBigInt(bytes2) {
    let v = 0n;
    for (const b2 of bytes2) {
      v = v << 8n | BYTE_TO_BIGINT_256[b2];
    }
    return v;
  }
  function bigIntToBytes(v, len) {
    const out = new Uint8Array(len);
    let n2 = v;
    for (let i = len - 1; i >= 0; i--) {
      out[i] = Number(n2 & 0xffn);
      n2 >>= 8n;
    }
    if (n2 !== 0n) {
      throw new Error("Invalid coordinate length");
    }
    return out;
  }
  function buildRawUncompressedPublicKey(x, y, coordinateSize) {
    const out = new Uint8Array(1 + coordinateSize * 2);
    out[0] = 4;
    out.set(bigIntToBytes(x, coordinateSize), 1);
    out.set(bigIntToBytes(y, coordinateSize), 1 + coordinateSize);
    return out;
  }
  var Ec = class extends NativeAlgorithm {
    constructor(kem, hkdf) {
      super();
      Object.defineProperty(this, "_hkdf", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_alg", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_nPk", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_nSk", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_nDh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_order", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_bitmask", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_pkcs8AlgId", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_curveParams", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this._hkdf = hkdf;
      switch (kem) {
        case KemId.DhkemP256HkdfSha256:
          this._alg = { name: "ECDH", namedCurve: "P-256" };
          this._nPk = 65;
          this._nSk = 32;
          this._nDh = 32;
          this._order = ORDER_P_256;
          this._bitmask = 255;
          this._pkcs8AlgId = PKCS8_ALG_ID_P_256;
          this._curveParams = EC_P_256_PARAMS;
          break;
        case KemId.DhkemP384HkdfSha384:
          this._alg = { name: "ECDH", namedCurve: "P-384" };
          this._nPk = 97;
          this._nSk = 48;
          this._nDh = 48;
          this._order = ORDER_P_384;
          this._bitmask = 255;
          this._pkcs8AlgId = PKCS8_ALG_ID_P_384;
          this._curveParams = EC_P_384_PARAMS;
          break;
        default:
          this._alg = { name: "ECDH", namedCurve: "P-521" };
          this._nPk = 133;
          this._nSk = 66;
          this._nDh = 66;
          this._order = ORDER_P_521;
          this._bitmask = 1;
          this._pkcs8AlgId = PKCS8_ALG_ID_P_521;
          this._curveParams = EC_P_521_PARAMS;
          break;
      }
    }
    async serializePublicKey(key) {
      await this._setup();
      try {
        return await this._api.exportKey("raw", key);
      } catch (e) {
        throw new SerializeError(e);
      }
    }
    async deserializePublicKey(key) {
      await this._setup();
      try {
        return await this._importRawKey(toArrayBuffer(key), true);
      } catch (e) {
        throw new DeserializeError(e);
      }
    }
    async serializePrivateKey(key) {
      await this._setup();
      try {
        const jwk = await this._api.exportKey("jwk", key);
        if (!("d" in jwk)) {
          throw new Error("Not private key");
        }
        return base64UrlToBytes(jwk["d"]).buffer;
      } catch (e) {
        throw new SerializeError(e);
      }
    }
    async deserializePrivateKey(key) {
      await this._setup();
      try {
        return await this._importRawKey(toArrayBuffer(key), false);
      } catch (e) {
        throw new DeserializeError(e);
      }
    }
    async importKey(format, key, isPublic) {
      await this._setup();
      try {
        if (format === "raw") {
          return await this._importRawKey(key, isPublic);
        }
        if (key instanceof ArrayBuffer) {
          throw new Error("Invalid jwk key format");
        }
        return await this._importJWK(key, isPublic);
      } catch (e) {
        throw new DeserializeError(e);
      }
    }
    async generateKeyPair() {
      await this._setup();
      try {
        return await this._api.generateKey(this._alg, true, KEM_USAGES);
      } catch (e) {
        throw new NotSupportedError(e);
      }
    }
    async deriveKeyPair(ikm) {
      await this._setup();
      try {
        const rawIkm = toArrayBuffer(ikm);
        const dkpPrk = await this._hkdf.labeledExtract(EMPTY, LABEL_DKP_PRK, new Uint8Array(rawIkm));
        const bn = new Bignum(this._nSk);
        for (let counter = 0; bn.isZero() || !bn.lessThan(this._order); counter++) {
          if (counter > 255) {
            throw new Error("Faild to derive a key pair");
          }
          const bytes2 = new Uint8Array(await this._hkdf.labeledExpand(dkpPrk, LABEL_CANDIDATE, i2Osp(counter, 1), this._nSk));
          bytes2[0] = bytes2[0] & this._bitmask;
          bn.set(bytes2);
        }
        const sk = await this._deserializePkcs8Key(bn.val());
        bn.reset();
        return {
          privateKey: sk,
          publicKey: await this.derivePublicKey(sk)
        };
      } catch (e) {
        throw new DeriveKeyPairError(e);
      }
    }
    async derivePublicKey(key) {
      await this._setup();
      try {
        const jwk = await this._api.exportKey("jwk", key);
        delete jwk["d"];
        delete jwk["key_ops"];
        return await this._api.importKey("jwk", jwk, this._alg, true, []);
      } catch {
        try {
          return await this._derivePublicKeyWithoutJwkExport(key);
        } catch (e) {
          throw new DeserializeError(e);
        }
      }
    }
    async dh(sk, pk) {
      try {
        await this._setup();
        const bits = await this._api.deriveBits({
          name: "ECDH",
          public: pk
        }, sk, this._nDh * 8);
        return bits;
      } catch (e) {
        throw new SerializeError(e);
      }
    }
    async _importRawKey(key, isPublic) {
      if (isPublic && key.byteLength !== this._nPk) {
        throw new Error("Invalid public key for the ciphersuite");
      }
      if (!isPublic && key.byteLength !== this._nSk) {
        throw new Error("Invalid private key for the ciphersuite");
      }
      if (isPublic) {
        return await this._api.importKey("raw", key, this._alg, true, []);
      }
      return await this._deserializePkcs8Key(new Uint8Array(key));
    }
    async _importJWK(key, isPublic) {
      if (typeof key.crv === "undefined" || key.crv !== this._alg.namedCurve) {
        throw new Error(`Invalid crv: ${key.crv}`);
      }
      if (isPublic) {
        if (typeof key.d !== "undefined") {
          throw new Error("Invalid key: `d` should not be set");
        }
        return await this._api.importKey("jwk", key, this._alg, true, []);
      }
      if (typeof key.d === "undefined") {
        throw new Error("Invalid key: `d` not found");
      }
      return await this._api.importKey("jwk", key, this._alg, true, KEM_USAGES);
    }
    async _deserializePkcs8Key(k) {
      const pkcs8Key = new Uint8Array(this._pkcs8AlgId.length + k.length);
      pkcs8Key.set(this._pkcs8AlgId, 0);
      pkcs8Key.set(k, this._pkcs8AlgId.length);
      return await this._api.importKey("pkcs8", pkcs8Key, this._alg, true, KEM_USAGES);
    }
    async _derivePublicKeyWithoutJwkExport(key) {
      const basePointRaw = buildRawUncompressedPublicKey(this._curveParams.gx, this._curveParams.gy, this._curveParams.coordinateSize);
      const basePoint = await this._api.importKey("raw", basePointRaw.buffer, this._alg, true, []);
      const xBytes = new Uint8Array(await this._api.deriveBits({
        name: "ECDH",
        public: basePoint
      }, key, this._nDh * 8));
      const p = this._curveParams.p;
      const x = bytesToBigInt(xBytes);
      const rhs = mod2(modPow(x, 3n, p) - 3n * x + this._curveParams.b, p);
      let y = modSqrt(rhs, p);
      if ((y & 1n) === 1n) {
        y = p - y;
      }
      const pubRaw = buildRawUncompressedPublicKey(x, y, this._curveParams.coordinateSize);
      return await this._api.importKey("raw", pubRaw.buffer, this._alg, true, []);
    }
  };

  // node_modules/@hpke/common/esm/src/xCryptoKey.js
  var XCryptoKey = class {
    constructor(name, key, type, usages = []) {
      Object.defineProperty(this, "key", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "type", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "extractable", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: true
      });
      Object.defineProperty(this, "algorithm", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "usages", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this.key = key;
      this.type = type;
      this.algorithm = { name };
      this.usages = usages;
      if (type === "public") {
        this.usages = [];
      }
    }
  };

  // node_modules/@hpke/common/esm/src/kems/dhkemPrimitives/xCurve.js
  var XCurveDhkemPrimitives = class {
    constructor(algName, keySize, curve, hkdf) {
      Object.defineProperty(this, "_algName", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_curve", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_hkdf", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_nPk", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_nSk", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this._algName = algName;
      this._nPk = keySize;
      this._nSk = keySize;
      this._curve = curve;
      this._hkdf = hkdf;
    }
    serializePublicKey(key) {
      try {
        return Promise.resolve(key.key.buffer);
      } catch (e) {
        return Promise.reject(new SerializeError(e));
      }
    }
    async deserializePublicKey(key) {
      try {
        return await this._importRawKey(toArrayBuffer(key), true);
      } catch (e) {
        throw new DeserializeError(e);
      }
    }
    serializePrivateKey(key) {
      try {
        return Promise.resolve(key.key.buffer);
      } catch (e) {
        return Promise.reject(new SerializeError(e));
      }
    }
    async deserializePrivateKey(key) {
      try {
        return await this._importRawKey(toArrayBuffer(key), false);
      } catch (e) {
        throw new DeserializeError(e);
      }
    }
    async importKey(format, key, isPublic) {
      try {
        if (format === "raw") {
          return await this._importRawKey(key, isPublic);
        }
        if (key instanceof ArrayBuffer) {
          throw new Error("Invalid jwk key format");
        }
        return await this._importJWK(key, isPublic);
      } catch (e) {
        throw new DeserializeError(e);
      }
    }
    async generateKeyPair() {
      try {
        const rawSk = await this._curve.utils.randomSecretKey();
        const sk = new XCryptoKey(this._algName, rawSk, "private", KEM_USAGES);
        const pk = await this.derivePublicKey(sk);
        return { publicKey: pk, privateKey: sk };
      } catch (e) {
        throw new NotSupportedError(e);
      }
    }
    async deriveKeyPair(ikm) {
      try {
        const rawIkm = toArrayBuffer(ikm);
        const dkpPrk = await this._hkdf.labeledExtract(EMPTY.buffer, LABEL_DKP_PRK, new Uint8Array(rawIkm));
        const rawSk = await this._hkdf.labeledExpand(dkpPrk, LABEL_SK, EMPTY, this._nSk);
        const sk = new XCryptoKey(this._algName, new Uint8Array(rawSk), "private", KEM_USAGES);
        return {
          privateKey: sk,
          publicKey: await this.derivePublicKey(sk)
        };
      } catch (e) {
        throw new DeriveKeyPairError(e);
      }
    }
    derivePublicKey(key) {
      try {
        const pk = this._curve.getPublicKey(key.key);
        return Promise.resolve(new XCryptoKey(this._algName, pk, "public"));
      } catch (e) {
        return Promise.reject(new DeserializeError(e));
      }
    }
    dh(sk, pk) {
      try {
        return Promise.resolve(this._curve.getSharedSecret(sk.key, pk.key).buffer);
      } catch (e) {
        return Promise.reject(new SerializeError(e));
      }
    }
    _importRawKey(key, isPublic) {
      return new Promise((resolve, reject) => {
        if (isPublic && key.byteLength !== this._nPk) {
          reject(new Error("Invalid length of the key"));
        }
        if (!isPublic && key.byteLength !== this._nSk) {
          reject(new Error("Invalid length of the key"));
        }
        resolve(new XCryptoKey(this._algName, new Uint8Array(key), isPublic ? "public" : "private", isPublic ? [] : KEM_USAGES));
      });
    }
    _importJWK(key, isPublic) {
      return new Promise((resolve, reject) => {
        if (key.kty !== "OKP") {
          reject(new Error(`Invalid kty: ${key.kty}`));
        }
        if (key.crv !== this._algName) {
          reject(new Error(`Invalid crv: ${key.crv}`));
        }
        if (isPublic) {
          if (typeof key.d !== "undefined") {
            reject(new Error("Invalid key: `d` should not be set"));
          }
          if (typeof key.x !== "string") {
            reject(new Error("Invalid key: `x` not found"));
          }
          resolve(new XCryptoKey(this._algName, base64UrlToBytes(key.x), "public"));
        } else {
          if (typeof key.d !== "string") {
            reject(new Error("Invalid key: `d` not found"));
          }
          resolve(new XCryptoKey(this._algName, base64UrlToBytes(key.d), "private", KEM_USAGES));
        }
      });
    }
  };

  // node_modules/@hpke/common/esm/src/interfaces/aeadEncryptionContext.js
  var AEAD_USAGES = ["encrypt", "decrypt"];

  // node_modules/@hpke/common/esm/src/utils/noble.js
  function isBytes(a) {
    return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
  }
  function anumber(n2, title = "") {
    if (!Number.isSafeInteger(n2) || n2 < 0) {
      const prefix = title && `"${title}" `;
      throw new Error(`${prefix}expected integer >0, got ${n2}`);
    }
  }
  function abytes(value, length, title = "") {
    const bytes2 = isBytes(value);
    const len = value?.length;
    const needsLen = length !== void 0;
    if (!bytes2 || needsLen && len !== length) {
      const prefix = title && `"${title}" `;
      const ofLen = needsLen ? ` of length ${length}` : "";
      const got = bytes2 ? `length=${len}` : `type=${typeof value}`;
      throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
    }
    return value;
  }
  function aexists(instance, checkFinished = true) {
    if (instance.destroyed)
      throw new Error("Hash instance has been destroyed");
    if (checkFinished && instance.finished) {
      throw new Error("Hash#digest() has already been called");
    }
  }
  function aoutput(out, instance) {
    abytes(out, void 0, "digestInto() output");
    const min = instance.outputLen;
    if (out.length < min) {
      throw new Error('"digestInto() output" expected to be of length >=' + min);
    }
  }
  function abignumer(n2) {
    if (typeof n2 === "bigint") {
      if (!isPosBig(n2))
        throw new Error("positive bigint expected, got " + n2);
    } else
      anumber(n2);
    return n2;
  }
  function u322(arr) {
    return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
  }
  function clean(...arrays) {
    for (let i = 0; i < arrays.length; i++) {
      arrays[i].fill(0);
    }
  }
  var _endianTestBuffer = /* @__PURE__ */ new Uint32Array([287454020]);
  var _endianTestBytes = /* @__PURE__ */ new Uint8Array(_endianTestBuffer.buffer);
  var isLE2 = _endianTestBytes[0] === 68;
  function createView2(arr) {
    return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  }
  function rotr2(word, shift) {
    return word << 32 - shift | word >>> shift;
  }
  var hasHexBuiltin = /* @__PURE__ */ (() => (
    // @ts-ignore: to use toHex
    typeof Uint8Array.from([]).toHex === "function" && // @ts-ignore: to use fromHex
    typeof Uint8Array.fromHex === "function"
  ))();
  var hexes2 = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
  var HEX_TO_BIGINT = [
    0n,
    1n,
    2n,
    3n,
    4n,
    5n,
    6n,
    7n,
    8n,
    9n,
    10n,
    11n,
    12n,
    13n,
    14n,
    15n
  ];
  function bytesToHex2(bytes2) {
    abytes(bytes2);
    if (hasHexBuiltin)
      return bytes2.toHex();
    let hex = "";
    for (let i = 0; i < bytes2.length; i++) {
      hex += hexes2[bytes2[i]];
    }
    return hex;
  }
  var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
  function asciiToBase16(ch) {
    if (ch >= asciis._0 && ch <= asciis._9)
      return ch - asciis._0;
    if (ch >= asciis.A && ch <= asciis.F)
      return ch - (asciis.A - 10);
    if (ch >= asciis.a && ch <= asciis.f)
      return ch - (asciis.a - 10);
    return;
  }
  function hexToBytes2(hex) {
    if (typeof hex !== "string") {
      throw new Error("hex string expected, got " + typeof hex);
    }
    if (hasHexBuiltin)
      return Uint8Array.fromHex(hex);
    const hl = hex.length;
    const al = hl / 2;
    if (hl % 2) {
      throw new Error("hex string expected, got unpadded hex of length " + hl);
    }
    const array = new Uint8Array(al);
    for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
      const n1 = asciiToBase16(hex.charCodeAt(hi));
      const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
      if (n1 === void 0 || n2 === void 0) {
        const char = hex[hi] + hex[hi + 1];
        throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
      }
      array[ai] = n1 * 16 + n2;
    }
    return array;
  }
  function hexToNumber2(hex) {
    if (typeof hex !== "string") {
      throw new Error("hex string expected, got " + typeof hex);
    }
    let out = N_0;
    for (let i = 0; i < hex.length; i++) {
      const n2 = asciiToBase16(hex.charCodeAt(i));
      if (n2 === void 0) {
        throw new Error('hex string expected, got non-hex character "' + hex[i] + '" at index ' + i);
      }
      out = out << 4n | HEX_TO_BIGINT[n2];
    }
    return out;
  }
  function numberToBigint(num) {
    anumber(num, "numberToBigint");
    let n2 = num;
    let out = N_0;
    let bit = 1n;
    while (n2 > 0) {
      if (n2 % 2 === 1)
        out += bit;
      n2 = Math.floor(n2 / 2);
      bit <<= 1n;
    }
    return out;
  }
  function bytesToNumberLE2(bytes2) {
    return hexToNumber2(bytesToHex2(copyBytes(abytes(bytes2)).reverse()));
  }
  function numberToBytesBE2(n2, len) {
    anumber(len);
    n2 = abignumer(n2);
    const res = hexToBytes2(n2.toString(16).padStart(len * 2, "0"));
    if (res.length !== len)
      throw new Error("number too large");
    return res;
  }
  function numberToBytesLE2(n2, len) {
    return numberToBytesBE2(n2, len).reverse();
  }
  function copyBytes(bytes2) {
    return Uint8Array.from(bytes2);
  }
  function isPosBig(n2) {
    return typeof n2 === "bigint" && N_0 <= n2;
  }
  function inRange(n2, min, max) {
    return isPosBig(n2) && isPosBig(min) && isPosBig(max) && min <= n2 && n2 < max;
  }
  function aInRange(title, n2, min, max) {
    if (!inRange(n2, min, max)) {
      throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n2);
    }
  }
  function validateObject2(object, fields = {}, optFields = {}) {
    if (!object || typeof object !== "object") {
      throw new Error("expected valid options object");
    }
    function checkField(fieldName, expectedType, isOpt) {
      const val = object[fieldName];
      if (isOpt && val === void 0)
        return;
      const current = typeof val;
      if (current !== expectedType || val === null) {
        throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
      }
    }
    const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
    iter(fields, false);
    iter(optFields, true);
  }
  async function randomBytesAsync(bytesLength = 32) {
    const api = await loadCrypto();
    const rnd = new Uint8Array(bytesLength);
    api.getRandomValues(rnd);
    return rnd;
  }
  function oidNist(suffix) {
    return {
      oid: Uint8Array.from([
        6,
        9,
        96,
        134,
        72,
        1,
        101,
        3,
        4,
        2,
        suffix
      ])
    };
  }

  // node_modules/@hpke/common/esm/src/hash/hash.js
  function ahash(h) {
    if (typeof h !== "function" || typeof h.create !== "function") {
      throw new Error("Hash must wrapped by utils.createHasher");
    }
    anumber(h.outputLen);
    anumber(h.blockLen);
  }
  function createHasher(hashCons, info = {}) {
    const hashFn = (msg, opts) => hashCons(opts).update(msg).digest();
    const tmp = hashCons(void 0);
    const hashC = Object.assign(hashFn, {
      outputLen: tmp.outputLen,
      blockLen: tmp.blockLen,
      create: (opts) => hashCons(opts),
      ...info
    });
    return Object.freeze(hashC);
  }

  // node_modules/@hpke/common/esm/src/hash/hmac.js
  var _HMAC = class {
    constructor(hash2, key) {
      Object.defineProperty(this, "oHash", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "iHash", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "blockLen", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "outputLen", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "finished", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: false
      });
      Object.defineProperty(this, "destroyed", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: false
      });
      ahash(hash2);
      abytes(key, void 0, "key");
      this.iHash = hash2.create();
      if (typeof this.iHash.update !== "function") {
        throw new Error("Expected instance of class which extends utils.Hash");
      }
      this.blockLen = this.iHash.blockLen;
      this.outputLen = this.iHash.outputLen;
      const blockLen = this.blockLen;
      const pad = new Uint8Array(blockLen);
      pad.set(key.length > blockLen ? hash2.create().update(key).digest() : key);
      for (let i = 0; i < pad.length; i++)
        pad[i] ^= 54;
      this.iHash.update(pad);
      this.oHash = hash2.create();
      for (let i = 0; i < pad.length; i++)
        pad[i] ^= 54 ^ 92;
      this.oHash.update(pad);
      clean(pad);
    }
    update(buf) {
      aexists(this);
      this.iHash.update(buf);
      return this;
    }
    digestInto(out) {
      aexists(this);
      abytes(out, this.outputLen, "output");
      this.finished = true;
      this.iHash.digestInto(out);
      this.oHash.update(out);
      this.oHash.digestInto(out);
      this.destroy();
    }
    digest() {
      const out = new Uint8Array(this.oHash.outputLen);
      this.digestInto(out);
      return out;
    }
    _cloneInto(to) {
      to ||= Object.create(Object.getPrototypeOf(this), {});
      const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
      to = to;
      to.finished = finished;
      to.destroyed = destroyed;
      to.blockLen = blockLen;
      to.outputLen = outputLen;
      to.oHash = oHash._cloneInto(to.oHash);
      to.iHash = iHash._cloneInto(to.iHash);
      return to;
    }
    clone() {
      return this._cloneInto();
    }
    destroy() {
      this.destroyed = true;
      this.oHash.destroy();
      this.iHash.destroy();
    }
  };
  var hmac2 = (hash2, key, message) => new _HMAC(hash2, key).update(message).digest();
  hmac2.create = (hash2, key) => new _HMAC(hash2, key);

  // node_modules/@hpke/common/esm/src/hash/md.js
  function Chi2(a, b2, c) {
    return a & b2 ^ ~a & c;
  }
  function Maj2(a, b2, c) {
    return a & b2 ^ a & c ^ b2 & c;
  }
  var HashMD = class {
    constructor(blockLen, outputLen, padOffset, isLE3) {
      Object.defineProperty(this, "blockLen", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "outputLen", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "padOffset", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "isLE", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "buffer", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "view", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "finished", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: false
      });
      Object.defineProperty(this, "length", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0
      });
      Object.defineProperty(this, "pos", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0
      });
      Object.defineProperty(this, "destroyed", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: false
      });
      this.blockLen = blockLen;
      this.outputLen = outputLen;
      this.padOffset = padOffset;
      this.isLE = isLE3;
      this.buffer = new Uint8Array(blockLen);
      this.view = createView2(this.buffer);
    }
    update(data) {
      aexists(this);
      abytes(data);
      const { view, buffer, blockLen } = this;
      const len = data.length;
      for (let pos = 0; pos < len; ) {
        const take = Math.min(blockLen - this.pos, len - pos);
        if (take === blockLen) {
          const dataView = createView2(data);
          for (; blockLen <= len - pos; pos += blockLen) {
            this.process(dataView, pos);
          }
          continue;
        }
        buffer.set(data.subarray(pos, pos + take), this.pos);
        this.pos += take;
        pos += take;
        if (this.pos === blockLen) {
          this.process(view, 0);
          this.pos = 0;
        }
      }
      this.length += data.length;
      this.roundClean();
      return this;
    }
    digestInto(out) {
      aexists(this);
      aoutput(out, this);
      this.finished = true;
      const { buffer, view, blockLen, isLE: isLE3 } = this;
      let { pos } = this;
      buffer[pos++] = 128;
      clean(this.buffer.subarray(pos));
      if (this.padOffset > blockLen - pos) {
        this.process(view, 0);
        pos = 0;
      }
      for (let i = pos; i < blockLen; i++)
        buffer[i] = 0;
      view.setBigUint64(blockLen - 8, numberToBigint(this.length * 8), isLE3);
      this.process(view, 0);
      const oview = createView2(out);
      const len = this.outputLen;
      if (len % 4)
        throw new Error("_sha2: outputLen must be aligned to 32bit");
      const outLen = len / 4;
      const state = this.get();
      if (outLen > state.length) {
        throw new Error("_sha2: outputLen bigger than state");
      }
      for (let i = 0; i < outLen; i++)
        oview.setUint32(4 * i, state[i], isLE3);
    }
    digest() {
      const { buffer, outputLen } = this;
      this.digestInto(buffer);
      const res = buffer.slice(0, outputLen);
      this.destroy();
      return res;
    }
    _cloneInto(to) {
      to ||= new this.constructor();
      to.set(...this.get());
      const { blockLen, buffer, length, finished, destroyed, pos } = this;
      to.destroyed = destroyed;
      to.finished = finished;
      to.length = length;
      to.pos = pos;
      if (length % blockLen)
        to.buffer.set(buffer);
      return to;
    }
    clone() {
      return this._cloneInto();
    }
  };
  var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  var SHA384_IV = /* @__PURE__ */ Uint32Array.from([
    3418070365,
    3238371032,
    1654270250,
    914150663,
    2438529370,
    812702999,
    355462360,
    4144912697,
    1731405415,
    4290775857,
    2394180231,
    1750603025,
    3675008525,
    1694076839,
    1203062813,
    3204075428
  ]);
  var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    4089235720,
    3144134277,
    2227873595,
    1013904242,
    4271175723,
    2773480762,
    1595750129,
    1359893119,
    2917565137,
    2600822924,
    725511199,
    528734635,
    4215389547,
    1541459225,
    327033209
  ]);

  // node_modules/@hpke/common/esm/src/hash/u64.js
  var U32_MASK642 = 0xffffffffn;
  var _32n2 = 32n;
  function fromBig2(n2, le = false) {
    if (le) {
      return { h: Number(n2 & U32_MASK642), l: Number(n2 >> _32n2 & U32_MASK642) };
    }
    return {
      h: Number(n2 >> _32n2 & U32_MASK642) | 0,
      l: Number(n2 & U32_MASK642) | 0
    };
  }
  function split2(lst, le = false) {
    const len = lst.length;
    const Ah = new Uint32Array(len);
    const Al = new Uint32Array(len);
    for (let i = 0; i < len; i++) {
      const { h, l } = fromBig2(lst[i], le);
      [Ah[i], Al[i]] = [h, l];
    }
    return [Ah, Al];
  }
  var shrSH2 = (h, _l, s) => h >>> s;
  var shrSL2 = (h, l, s) => h << 32 - s | l >>> s;
  var rotrSH2 = (h, l, s) => h >>> s | l << 32 - s;
  var rotrSL2 = (h, l, s) => h << 32 - s | l >>> s;
  var rotrBH2 = (h, l, s) => h << 64 - s | l >>> s - 32;
  var rotrBL2 = (h, l, s) => h >>> s - 32 | l << 64 - s;
  function add2(Ah, Al, Bh, Bl) {
    const l = (Al >>> 0) + (Bl >>> 0);
    return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
  }
  var add3L2 = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
  var add3H2 = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
  var add4L2 = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
  var add4H2 = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
  var add5L2 = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
  var add5H2 = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

  // node_modules/@hpke/common/esm/src/hash/sha2.js
  var SHA256_K2 = /* @__PURE__ */ Uint32Array.from([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  var SHA256_W2 = /* @__PURE__ */ new Uint32Array(64);
  var SHA2_32B = class extends HashMD {
    constructor(outputLen) {
      super(64, outputLen, 8, false);
    }
    get() {
      const { A, B, C, D, E, F, G, H } = this;
      return [A, B, C, D, E, F, G, H];
    }
    set(A, B, C, D, E, F, G, H) {
      this.A = A | 0;
      this.B = B | 0;
      this.C = C | 0;
      this.D = D | 0;
      this.E = E | 0;
      this.F = F | 0;
      this.G = G | 0;
      this.H = H | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4) {
        SHA256_W2[i] = view.getUint32(offset, false);
      }
      for (let i = 16; i < 64; i++) {
        const W15 = SHA256_W2[i - 15];
        const W2 = SHA256_W2[i - 2];
        const s0 = rotr2(W15, 7) ^ rotr2(W15, 18) ^ W15 >>> 3;
        const s1 = rotr2(W2, 17) ^ rotr2(W2, 19) ^ W2 >>> 10;
        SHA256_W2[i] = s1 + SHA256_W2[i - 7] + s0 + SHA256_W2[i - 16] | 0;
      }
      let { A, B, C, D, E, F, G, H } = this;
      for (let i = 0; i < 64; i++) {
        const sigma1 = rotr2(E, 6) ^ rotr2(E, 11) ^ rotr2(E, 25);
        const T1 = H + sigma1 + Chi2(E, F, G) + SHA256_K2[i] + SHA256_W2[i] | 0;
        const sigma0 = rotr2(A, 2) ^ rotr2(A, 13) ^ rotr2(A, 22);
        const T2 = sigma0 + Maj2(A, B, C) | 0;
        H = G;
        G = F;
        F = E;
        E = D + T1 | 0;
        D = C;
        C = B;
        B = A;
        A = T1 + T2 | 0;
      }
      A = A + this.A | 0;
      B = B + this.B | 0;
      C = C + this.C | 0;
      D = D + this.D | 0;
      E = E + this.E | 0;
      F = F + this.F | 0;
      G = G + this.G | 0;
      H = H + this.H | 0;
      this.set(A, B, C, D, E, F, G, H);
    }
    roundClean() {
      clean(SHA256_W2);
    }
    destroy() {
      this.set(0, 0, 0, 0, 0, 0, 0, 0);
      clean(this.buffer);
    }
  };
  var _SHA256 = class extends SHA2_32B {
    constructor() {
      super(32);
      Object.defineProperty(this, "A", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA256_IV[0] | 0
      });
      Object.defineProperty(this, "B", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA256_IV[1] | 0
      });
      Object.defineProperty(this, "C", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA256_IV[2] | 0
      });
      Object.defineProperty(this, "D", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA256_IV[3] | 0
      });
      Object.defineProperty(this, "E", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA256_IV[4] | 0
      });
      Object.defineProperty(this, "F", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA256_IV[5] | 0
      });
      Object.defineProperty(this, "G", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA256_IV[6] | 0
      });
      Object.defineProperty(this, "H", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA256_IV[7] | 0
      });
    }
  };
  var K512 = /* @__PURE__ */ (() => split2([
    0x428a2f98d728ae22n,
    0x7137449123ef65cdn,
    0xb5c0fbcfec4d3b2fn,
    0xe9b5dba58189dbbcn,
    0x3956c25bf348b538n,
    0x59f111f1b605d019n,
    0x923f82a4af194f9bn,
    0xab1c5ed5da6d8118n,
    0xd807aa98a3030242n,
    0x12835b0145706fben,
    0x243185be4ee4b28cn,
    0x550c7dc3d5ffb4e2n,
    0x72be5d74f27b896fn,
    0x80deb1fe3b1696b1n,
    0x9bdc06a725c71235n,
    0xc19bf174cf692694n,
    0xe49b69c19ef14ad2n,
    0xefbe4786384f25e3n,
    0x0fc19dc68b8cd5b5n,
    0x240ca1cc77ac9c65n,
    0x2de92c6f592b0275n,
    0x4a7484aa6ea6e483n,
    0x5cb0a9dcbd41fbd4n,
    0x76f988da831153b5n,
    0x983e5152ee66dfabn,
    0xa831c66d2db43210n,
    0xb00327c898fb213fn,
    0xbf597fc7beef0ee4n,
    0xc6e00bf33da88fc2n,
    0xd5a79147930aa725n,
    0x06ca6351e003826fn,
    0x142929670a0e6e70n,
    0x27b70a8546d22ffcn,
    0x2e1b21385c26c926n,
    0x4d2c6dfc5ac42aedn,
    0x53380d139d95b3dfn,
    0x650a73548baf63den,
    0x766a0abb3c77b2a8n,
    0x81c2c92e47edaee6n,
    0x92722c851482353bn,
    0xa2bfe8a14cf10364n,
    0xa81a664bbc423001n,
    0xc24b8b70d0f89791n,
    0xc76c51a30654be30n,
    0xd192e819d6ef5218n,
    0xd69906245565a910n,
    0xf40e35855771202an,
    0x106aa07032bbd1b8n,
    0x19a4c116b8d2d0c8n,
    0x1e376c085141ab53n,
    0x2748774cdf8eeb99n,
    0x34b0bcb5e19b48a8n,
    0x391c0cb3c5c95a63n,
    0x4ed8aa4ae3418acbn,
    0x5b9cca4f7763e373n,
    0x682e6ff3d6b2b8a3n,
    0x748f82ee5defb2fcn,
    0x78a5636f43172f60n,
    0x84c87814a1f0ab72n,
    0x8cc702081a6439ecn,
    0x90befffa23631e28n,
    0xa4506cebde82bde9n,
    0xbef9a3f7b2c67915n,
    0xc67178f2e372532bn,
    0xca273eceea26619cn,
    0xd186b8c721c0c207n,
    0xeada7dd6cde0eb1en,
    0xf57d4f7fee6ed178n,
    0x06f067aa72176fban,
    0x0a637dc5a2c898a6n,
    0x113f9804bef90daen,
    0x1b710b35131c471bn,
    0x28db77f523047d84n,
    0x32caab7b40c72493n,
    0x3c9ebe0a15c9bebcn,
    0x431d67c49c100d4cn,
    0x4cc5d4becb3e42b6n,
    0x597f299cfc657e2an,
    0x5fcb6fab3ad6faecn,
    0x6c44198c4a475817n
  ]))();
  var SHA512_Kh2 = /* @__PURE__ */ (() => K512[0])();
  var SHA512_Kl2 = /* @__PURE__ */ (() => K512[1])();
  var SHA512_W_H2 = /* @__PURE__ */ new Uint32Array(80);
  var SHA512_W_L2 = /* @__PURE__ */ new Uint32Array(80);
  var SHA2_64B = class extends HashMD {
    constructor(outputLen) {
      super(128, outputLen, 16, false);
    }
    get() {
      const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
    }
    set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
      this.Ah = Ah | 0;
      this.Al = Al | 0;
      this.Bh = Bh | 0;
      this.Bl = Bl | 0;
      this.Ch = Ch | 0;
      this.Cl = Cl | 0;
      this.Dh = Dh | 0;
      this.Dl = Dl | 0;
      this.Eh = Eh | 0;
      this.El = El | 0;
      this.Fh = Fh | 0;
      this.Fl = Fl | 0;
      this.Gh = Gh | 0;
      this.Gl = Gl | 0;
      this.Hh = Hh | 0;
      this.Hl = Hl | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4) {
        SHA512_W_H2[i] = view.getUint32(offset);
        SHA512_W_L2[i] = view.getUint32(offset += 4);
      }
      for (let i = 16; i < 80; i++) {
        const W15h = SHA512_W_H2[i - 15] | 0;
        const W15l = SHA512_W_L2[i - 15] | 0;
        const s0h = rotrSH2(W15h, W15l, 1) ^ rotrSH2(W15h, W15l, 8) ^ shrSH2(W15h, W15l, 7);
        const s0l = rotrSL2(W15h, W15l, 1) ^ rotrSL2(W15h, W15l, 8) ^ shrSL2(W15h, W15l, 7);
        const W2h = SHA512_W_H2[i - 2] | 0;
        const W2l = SHA512_W_L2[i - 2] | 0;
        const s1h = rotrSH2(W2h, W2l, 19) ^ rotrBH2(W2h, W2l, 61) ^ shrSH2(W2h, W2l, 6);
        const s1l = rotrSL2(W2h, W2l, 19) ^ rotrBL2(W2h, W2l, 61) ^ shrSL2(W2h, W2l, 6);
        const SUMl = add4L2(s0l, s1l, SHA512_W_L2[i - 7], SHA512_W_L2[i - 16]);
        const SUMh = add4H2(SUMl, s0h, s1h, SHA512_W_H2[i - 7], SHA512_W_H2[i - 16]);
        SHA512_W_H2[i] = SUMh | 0;
        SHA512_W_L2[i] = SUMl | 0;
      }
      let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      for (let i = 0; i < 80; i++) {
        const sigma1h = rotrSH2(Eh, El, 14) ^ rotrSH2(Eh, El, 18) ^ rotrBH2(Eh, El, 41);
        const sigma1l = rotrSL2(Eh, El, 14) ^ rotrSL2(Eh, El, 18) ^ rotrBL2(Eh, El, 41);
        const CHIh = Eh & Fh ^ ~Eh & Gh;
        const CHIl = El & Fl ^ ~El & Gl;
        const T1ll = add5L2(Hl, sigma1l, CHIl, SHA512_Kl2[i], SHA512_W_L2[i]);
        const T1h = add5H2(T1ll, Hh, sigma1h, CHIh, SHA512_Kh2[i], SHA512_W_H2[i]);
        const T1l = T1ll | 0;
        const sigma0h = rotrSH2(Ah, Al, 28) ^ rotrBH2(Ah, Al, 34) ^ rotrBH2(Ah, Al, 39);
        const sigma0l = rotrSL2(Ah, Al, 28) ^ rotrBL2(Ah, Al, 34) ^ rotrBL2(Ah, Al, 39);
        const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
        const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
        Hh = Gh | 0;
        Hl = Gl | 0;
        Gh = Fh | 0;
        Gl = Fl | 0;
        Fh = Eh | 0;
        Fl = El | 0;
        ({ h: Eh, l: El } = add2(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
        Dh = Ch | 0;
        Dl = Cl | 0;
        Ch = Bh | 0;
        Cl = Bl | 0;
        Bh = Ah | 0;
        Bl = Al | 0;
        const All = add3L2(T1l, sigma0l, MAJl);
        Ah = add3H2(All, T1h, sigma0h, MAJh);
        Al = All | 0;
      }
      ({ h: Ah, l: Al } = add2(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
      ({ h: Bh, l: Bl } = add2(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
      ({ h: Ch, l: Cl } = add2(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
      ({ h: Dh, l: Dl } = add2(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
      ({ h: Eh, l: El } = add2(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
      ({ h: Fh, l: Fl } = add2(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
      ({ h: Gh, l: Gl } = add2(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
      ({ h: Hh, l: Hl } = add2(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
      this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
    }
    roundClean() {
      clean(SHA512_W_H2, SHA512_W_L2);
    }
    destroy() {
      clean(this.buffer);
      this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  };
  var _SHA512 = class extends SHA2_64B {
    constructor() {
      super(64);
      Object.defineProperty(this, "Ah", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[0] | 0
      });
      Object.defineProperty(this, "Al", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[1] | 0
      });
      Object.defineProperty(this, "Bh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[2] | 0
      });
      Object.defineProperty(this, "Bl", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[3] | 0
      });
      Object.defineProperty(this, "Ch", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[4] | 0
      });
      Object.defineProperty(this, "Cl", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[5] | 0
      });
      Object.defineProperty(this, "Dh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[6] | 0
      });
      Object.defineProperty(this, "Dl", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[7] | 0
      });
      Object.defineProperty(this, "Eh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[8] | 0
      });
      Object.defineProperty(this, "El", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[9] | 0
      });
      Object.defineProperty(this, "Fh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[10] | 0
      });
      Object.defineProperty(this, "Fl", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[11] | 0
      });
      Object.defineProperty(this, "Gh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[12] | 0
      });
      Object.defineProperty(this, "Gl", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[13] | 0
      });
      Object.defineProperty(this, "Hh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[14] | 0
      });
      Object.defineProperty(this, "Hl", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA512_IV[15] | 0
      });
    }
  };
  var _SHA384 = class extends SHA2_64B {
    constructor() {
      super(48);
      Object.defineProperty(this, "Ah", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[0] | 0
      });
      Object.defineProperty(this, "Al", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[1] | 0
      });
      Object.defineProperty(this, "Bh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[2] | 0
      });
      Object.defineProperty(this, "Bl", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[3] | 0
      });
      Object.defineProperty(this, "Ch", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[4] | 0
      });
      Object.defineProperty(this, "Cl", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[5] | 0
      });
      Object.defineProperty(this, "Dh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[6] | 0
      });
      Object.defineProperty(this, "Dl", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[7] | 0
      });
      Object.defineProperty(this, "Eh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[8] | 0
      });
      Object.defineProperty(this, "El", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[9] | 0
      });
      Object.defineProperty(this, "Fh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[10] | 0
      });
      Object.defineProperty(this, "Fl", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[11] | 0
      });
      Object.defineProperty(this, "Gh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[12] | 0
      });
      Object.defineProperty(this, "Gl", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[13] | 0
      });
      Object.defineProperty(this, "Hh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[14] | 0
      });
      Object.defineProperty(this, "Hl", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: SHA384_IV[15] | 0
      });
    }
  };
  var sha2563 = /* @__PURE__ */ createHasher(
    () => new _SHA256(),
    /* @__PURE__ */ oidNist(1)
  );
  var sha5123 = /* @__PURE__ */ createHasher(
    () => new _SHA512(),
    /* @__PURE__ */ oidNist(3)
  );
  var sha384 = /* @__PURE__ */ createHasher(
    () => new _SHA384(),
    /* @__PURE__ */ oidNist(2)
  );

  // node_modules/@hpke/common/esm/src/hash/sha3.js
  var _0n7 = 0n;
  var _1n7 = 1n;
  var _2n6 = 2n;
  var _7n2 = 7n;
  var _256n2 = 256n;
  var _0x71n2 = 0x71n;
  var SHA3_PI2 = [];
  var SHA3_ROTL2 = [];
  var _SHA3_IOTA2 = [];
  for (let round = 0, R = _1n7, x = 1, y = 0; round < 24; round++) {
    [x, y] = [y, (2 * x + 3 * y) % 5];
    SHA3_PI2.push(2 * (5 * y + x));
    SHA3_ROTL2.push((round + 1) * (round + 2) / 2 % 64);
    let t = _0n7;
    for (let j = 0; j < 7; j++) {
      R = (R << _1n7 ^ (R >> _7n2) * _0x71n2) % _256n2;
      if (R & _2n6)
        t ^= _1n7 << (_1n7 << BigInt(j)) - _1n7;
    }
    _SHA3_IOTA2.push(t);
  }
  var IOTAS = split2(_SHA3_IOTA2, true);
  var SHA3_IOTA_H2 = IOTAS[0];
  var SHA3_IOTA_L2 = IOTAS[1];

  // node_modules/@hpke/common/esm/src/curve/modular.js
  function mod3(a, b2) {
    const result = a % b2;
    return result >= N_0 ? result : b2 + result;
  }
  function pow22(x, power, modulo) {
    let res = x;
    while (power-- > N_0) {
      res *= res;
      res %= modulo;
    }
    return res;
  }

  // node_modules/@hpke/common/esm/src/curve/curve.js
  function createKeygen(randomSecretKey, getPublicKey) {
    return function keygen(seed) {
      const secretKey = randomSecretKey(seed);
      return { secretKey, publicKey: getPublicKey(secretKey) };
    };
  }

  // node_modules/@hpke/common/esm/src/curve/montgomery.js
  function validateOpts2(curve) {
    validateObject2(curve, {
      adjustScalarBytes: "function",
      powPminus2: "function"
    });
    return Object.freeze({ ...curve });
  }
  function montgomery(curveDef) {
    const CURVE = validateOpts2(curveDef);
    const { P, type, adjustScalarBytes: adjustScalarBytes3, powPminus2, randomBytes: rand } = CURVE;
    const is25519 = type === "x25519";
    if (!is25519 && type !== "x448")
      throw new Error("invalid type");
    const randomBytes_ = rand || randomBytesAsync;
    const montgomeryBits = is25519 ? 255n : 448n;
    const fieldLen = is25519 ? 32 : 56;
    const Gu = is25519 ? 9n : 5n;
    const a24 = is25519 ? 121665n : 39081n;
    const minScalar = is25519 ? N_2 ** 254n : N_2 ** 447n;
    const maxAdded = is25519 ? 8n * N_2 ** 251n - N_1 : 4n * N_2 ** 445n - N_1;
    const maxScalar = minScalar + maxAdded + N_1;
    const modP = (n2) => mod3(n2, P);
    const GuBytes = encodeU(Gu);
    function encodeU(u) {
      return numberToBytesLE2(modP(u), fieldLen);
    }
    function decodeU(u) {
      const _u = copyBytes(abytes(u, fieldLen, "uCoordinate"));
      if (is25519)
        _u[31] &= 127;
      return modP(bytesToNumberLE2(_u));
    }
    function decodeScalar(scalar) {
      return bytesToNumberLE2(adjustScalarBytes3(copyBytes(abytes(scalar, fieldLen, "scalar"))));
    }
    function scalarMult(scalar, u) {
      const pu = montgomeryLadder(decodeU(u), decodeScalar(scalar));
      if (pu === N_0)
        throw new Error("invalid private or public key received");
      return encodeU(pu);
    }
    function scalarMultBase(scalar) {
      return scalarMult(scalar, GuBytes);
    }
    const getPublicKey = scalarMultBase;
    const getSharedSecret = scalarMult;
    function cswap(swap, x_2, x_3) {
      const dummy = modP(swap * (x_2 - x_3));
      x_2 = modP(x_2 - dummy);
      x_3 = modP(x_3 + dummy);
      return { x_2, x_3 };
    }
    function montgomeryLadder(u, scalar) {
      aInRange("u", u, N_0, P);
      aInRange("scalar", scalar, minScalar, maxScalar);
      const k = scalar;
      const x_1 = u;
      let x_2 = N_1;
      let z_2 = N_0;
      let x_3 = u;
      let z_3 = N_1;
      let swap = N_0;
      for (let t = montgomeryBits - 1n; t >= N_0; t--) {
        const k_t = k >> t & N_1;
        swap ^= k_t;
        ({ x_2, x_3 } = cswap(swap, x_2, x_3));
        ({ x_2: z_2, x_3: z_3 } = cswap(swap, z_2, z_3));
        swap = k_t;
        const A = x_2 + z_2;
        const AA = modP(A * A);
        const B = x_2 - z_2;
        const BB = modP(B * B);
        const E = AA - BB;
        const C = x_3 + z_3;
        const D = x_3 - z_3;
        const DA = modP(D * A);
        const CB = modP(C * B);
        const dacb = DA + CB;
        const da_cb = DA - CB;
        x_3 = modP(dacb * dacb);
        z_3 = modP(x_1 * modP(da_cb * da_cb));
        x_2 = modP(AA * BB);
        z_2 = modP(E * (AA + modP(a24 * E)));
      }
      ({ x_2, x_3 } = cswap(swap, x_2, x_3));
      ({ x_2: z_2, x_3: z_3 } = cswap(swap, z_2, z_3));
      const z2 = powPminus2(z_2);
      return modP(x_2 * z2);
    }
    const lengths = {
      secretKey: fieldLen,
      publicKey: fieldLen,
      seed: fieldLen
    };
    const randomSecretKey = async (seed) => {
      if (seed === void 0) {
        seed = await randomBytes_(fieldLen);
      }
      abytes(seed, lengths.seed, "seed");
      return seed;
    };
    const utils = { randomSecretKey };
    return Object.freeze({
      keygen: createKeygen(randomSecretKey, getPublicKey),
      getSharedSecret,
      getPublicKey,
      scalarMult,
      scalarMultBase,
      utils,
      GuBytes: GuBytes.slice(),
      lengths
    });
  }

  // node_modules/@hpke/core/esm/src/aeads/aesGcm.js
  var AesGcmContext = class extends NativeAlgorithm {
    constructor(key) {
      super();
      Object.defineProperty(this, "_rawKey", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_key", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this._rawKey = toArrayBuffer(key);
    }
    async seal(iv, data, aad) {
      await this._setupKey();
      const alg = {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(aad)
      };
      const ct = await this._api.encrypt(alg, this._key, toArrayBuffer(data));
      return ct;
    }
    async open(iv, data, aad) {
      await this._setupKey();
      const alg = {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(aad)
      };
      const pt = await this._api.decrypt(alg, this._key, toArrayBuffer(data));
      return pt;
    }
    async _setupKey() {
      if (this._key !== void 0) {
        return;
      }
      await this._setup();
      const key = await this._importKey(this._rawKey);
      new Uint8Array(this._rawKey).fill(0);
      this._key = key;
      return;
    }
    async _importKey(key) {
      return await this._api.importKey("raw", key, { name: "AES-GCM" }, true, AEAD_USAGES);
    }
  };
  var Aes128Gcm = class {
    constructor() {
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: AeadId.Aes128Gcm
      });
      Object.defineProperty(this, "keySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 16
      });
      Object.defineProperty(this, "nonceSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 12
      });
      Object.defineProperty(this, "tagSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 16
      });
    }
    createEncryptionContext(key) {
      return new AesGcmContext(key);
    }
  };
  var Aes256Gcm = class extends Aes128Gcm {
    constructor() {
      super(...arguments);
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: AeadId.Aes256Gcm
      });
      Object.defineProperty(this, "keySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32
      });
      Object.defineProperty(this, "nonceSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 12
      });
      Object.defineProperty(this, "tagSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 16
      });
    }
  };

  // node_modules/@hpke/core/esm/src/aeads/exportOnly.js
  var ExportOnly = class {
    constructor() {
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: AeadId.ExportOnly
      });
      Object.defineProperty(this, "keySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0
      });
      Object.defineProperty(this, "nonceSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0
      });
      Object.defineProperty(this, "tagSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0
      });
    }
    createEncryptionContext(_key) {
      throw new NotSupportedError("Export only");
    }
  };

  // node_modules/@hpke/core/esm/src/utils/emitNotSupported.js
  function emitNotSupported() {
    return new Promise((_resolve, reject) => {
      reject(new NotSupportedError("Not supported"));
    });
  }

  // node_modules/@hpke/core/esm/src/exporterContext.js
  var LABEL_SEC = new Uint8Array([115, 101, 99]);
  var ExporterContextImpl = class {
    constructor(api, kdf, exporterSecret) {
      Object.defineProperty(this, "_api", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "exporterSecret", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_kdf", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this._api = api;
      this._kdf = kdf;
      this.exporterSecret = exporterSecret;
    }
    async seal(_data, _aad) {
      return await emitNotSupported();
    }
    async open(_data, _aad) {
      return await emitNotSupported();
    }
    async export(exporterContext, len) {
      const rawExporterContext = toArrayBuffer(exporterContext);
      if (rawExporterContext.byteLength > INPUT_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long exporter context");
      }
      try {
        return await this._kdf.labeledExpand(this.exporterSecret, LABEL_SEC, new Uint8Array(rawExporterContext), len);
      } catch (e) {
        throw new ExportError(e);
      }
    }
  };
  var RecipientExporterContextImpl = class extends ExporterContextImpl {
  };
  var SenderExporterContextImpl = class extends ExporterContextImpl {
    constructor(api, kdf, exporterSecret, enc) {
      super(api, kdf, exporterSecret);
      Object.defineProperty(this, "enc", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this.enc = enc;
      return;
    }
  };

  // node_modules/@hpke/core/esm/src/encryptionContext.js
  var EncryptionContextImpl = class extends ExporterContextImpl {
    constructor(api, kdf, params) {
      super(api, kdf, params.exporterSecret);
      Object.defineProperty(this, "_aead", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_nK", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_nN", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_nT", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_ctx", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      if (params.key === void 0 || params.baseNonce === void 0 || params.seq === void 0) {
        throw new Error("Required parameters are missing");
      }
      this._aead = params.aead;
      this._nK = this._aead.keySize;
      this._nN = this._aead.nonceSize;
      this._nT = this._aead.tagSize;
      const key = this._aead.createEncryptionContext(params.key);
      this._ctx = {
        key,
        baseNonce: params.baseNonce,
        seq: params.seq
      };
    }
    computeNonce(k) {
      const seqBytes = i2Osp(k.seq, k.baseNonce.byteLength);
      return xor(k.baseNonce, seqBytes).buffer;
    }
    incrementSeq(k) {
      if (k.seq > Number.MAX_SAFE_INTEGER) {
        throw new MessageLimitReachedError("Message limit reached");
      }
      k.seq += 1;
      return;
    }
  };

  // node_modules/@hpke/core/esm/src/mutex.js
  var __classPrivateFieldGet = function(receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
  };
  var __classPrivateFieldSet = function(receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
  };
  var _Mutex_locked;
  var Mutex = class {
    constructor() {
      _Mutex_locked.set(this, Promise.resolve());
    }
    async lock() {
      let releaseLock;
      const nextLock = new Promise((resolve) => {
        releaseLock = resolve;
      });
      const previousLock = __classPrivateFieldGet(this, _Mutex_locked, "f");
      __classPrivateFieldSet(this, _Mutex_locked, nextLock, "f");
      await previousLock;
      return releaseLock;
    }
  };
  _Mutex_locked = /* @__PURE__ */ new WeakMap();

  // node_modules/@hpke/core/esm/src/recipientContext.js
  var __classPrivateFieldGet2 = function(receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
  };
  var __classPrivateFieldSet2 = function(receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
  };
  var _RecipientContextImpl_mutex;
  var RecipientContextImpl = class extends EncryptionContextImpl {
    constructor() {
      super(...arguments);
      _RecipientContextImpl_mutex.set(this, void 0);
    }
    async open(data, aad = EMPTY.buffer) {
      __classPrivateFieldSet2(this, _RecipientContextImpl_mutex, __classPrivateFieldGet2(this, _RecipientContextImpl_mutex, "f") ?? new Mutex(), "f");
      const release = await __classPrivateFieldGet2(this, _RecipientContextImpl_mutex, "f").lock();
      let pt;
      try {
        pt = await this._ctx.key.open(this.computeNonce(this._ctx), toArrayBuffer(data), toArrayBuffer(aad));
      } catch (e) {
        throw new OpenError(e);
      } finally {
        release();
      }
      this.incrementSeq(this._ctx);
      return pt;
    }
  };
  _RecipientContextImpl_mutex = /* @__PURE__ */ new WeakMap();

  // node_modules/@hpke/core/esm/src/senderContext.js
  var __classPrivateFieldGet3 = function(receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
  };
  var __classPrivateFieldSet3 = function(receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
  };
  var _SenderContextImpl_mutex;
  var SenderContextImpl = class extends EncryptionContextImpl {
    constructor(api, kdf, params, enc) {
      super(api, kdf, params);
      Object.defineProperty(this, "enc", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      _SenderContextImpl_mutex.set(this, void 0);
      this.enc = enc;
    }
    async seal(data, aad = EMPTY.buffer) {
      __classPrivateFieldSet3(this, _SenderContextImpl_mutex, __classPrivateFieldGet3(this, _SenderContextImpl_mutex, "f") ?? new Mutex(), "f");
      const release = await __classPrivateFieldGet3(this, _SenderContextImpl_mutex, "f").lock();
      let ct;
      try {
        ct = await this._ctx.key.seal(this.computeNonce(this._ctx), toArrayBuffer(data), toArrayBuffer(aad));
      } catch (e) {
        throw new SealError(e);
      } finally {
        release();
      }
      this.incrementSeq(this._ctx);
      return ct;
    }
  };
  _SenderContextImpl_mutex = /* @__PURE__ */ new WeakMap();

  // node_modules/@hpke/core/esm/src/cipherSuiteNative.js
  var LABEL_BASE_NONCE = new Uint8Array([
    98,
    97,
    115,
    101,
    95,
    110,
    111,
    110,
    99,
    101
  ]);
  var LABEL_EXP = new Uint8Array([101, 120, 112]);
  var LABEL_INFO_HASH = new Uint8Array([
    105,
    110,
    102,
    111,
    95,
    104,
    97,
    115,
    104
  ]);
  var LABEL_KEY = new Uint8Array([107, 101, 121]);
  var LABEL_PSK_ID_HASH = new Uint8Array([
    112,
    115,
    107,
    95,
    105,
    100,
    95,
    104,
    97,
    115,
    104
  ]);
  var LABEL_SECRET = new Uint8Array([115, 101, 99, 114, 101, 116]);
  var SUITE_ID_HEADER_HPKE = new Uint8Array([
    72,
    80,
    75,
    69,
    0,
    0,
    0,
    0,
    0,
    0
  ]);
  var CipherSuiteNative = class extends NativeAlgorithm {
    /**
     * @param params A set of parameters for building a cipher suite.
     *
     * If the error occurred, throws {@link InvalidParamError}.
     *
     * @throws {@link InvalidParamError}
     */
    constructor(params) {
      super();
      Object.defineProperty(this, "_kem", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_kdf", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_aead", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "_suiteId", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      if (typeof params.kem === "number") {
        throw new InvalidParamError("KemId cannot be used");
      }
      this._kem = params.kem;
      if (typeof params.kdf === "number") {
        throw new InvalidParamError("KdfId cannot be used");
      }
      this._kdf = params.kdf;
      if (typeof params.aead === "number") {
        throw new InvalidParamError("AeadId cannot be used");
      }
      this._aead = params.aead;
      this._suiteId = new Uint8Array(SUITE_ID_HEADER_HPKE);
      this._suiteId.set(i2Osp(this._kem.id, 2), 4);
      this._suiteId.set(i2Osp(this._kdf.id, 2), 6);
      this._suiteId.set(i2Osp(this._aead.id, 2), 8);
      this._kdf.init(this._suiteId);
    }
    /**
     * Gets the KEM context of the ciphersuite.
     */
    get kem() {
      return this._kem;
    }
    /**
     * Gets the KDF context of the ciphersuite.
     */
    get kdf() {
      return this._kdf;
    }
    /**
     * Gets the AEAD context of the ciphersuite.
     */
    get aead() {
      return this._aead;
    }
    /**
     * Creates an encryption context for a sender.
     *
     * If the error occurred, throws {@link DecapError} | {@link ValidationError}.
     *
     * @param params A set of parameters for the sender encryption context.
     * @returns A sender encryption context.
     * @throws {@link EncapError}, {@link ValidationError}
     */
    async createSenderContext(params) {
      this._validateInputLength(params);
      await this._setup();
      const dh = await this._kem.encap(params);
      let mode;
      if (params.psk !== void 0) {
        mode = params.senderKey !== void 0 ? Mode.AuthPsk : Mode.Psk;
      } else {
        mode = params.senderKey !== void 0 ? Mode.Auth : Mode.Base;
      }
      return await this._keyScheduleS(mode, dh.sharedSecret, dh.enc, params);
    }
    /**
     * Creates an encryption context for a recipient.
     *
     * If the error occurred, throws {@link DecapError}
     * | {@link DeserializeError} | {@link ValidationError}.
     *
     * @param params A set of parameters for the recipient encryption context.
     * @returns A recipient encryption context.
     * @throws {@link DecapError}, {@link DeserializeError}, {@link ValidationError}
     */
    async createRecipientContext(params) {
      this._validateInputLength(params);
      await this._setup();
      const sharedSecret = await this._kem.decap(params);
      let mode;
      if (params.psk !== void 0) {
        mode = params.senderPublicKey !== void 0 ? Mode.AuthPsk : Mode.Psk;
      } else {
        mode = params.senderPublicKey !== void 0 ? Mode.Auth : Mode.Base;
      }
      return await this._keyScheduleR(mode, sharedSecret, params);
    }
    /**
     * Encrypts a message to a recipient.
     *
     * If the error occurred, throws `EncapError` | `MessageLimitReachedError` | `SealError` | `ValidationError`.
     *
     * @param params A set of parameters for building a sender encryption context.
     * @param pt A plain text as bytes to be encrypted.
     * @param aad Additional authenticated data as bytes fed by an application.
     * @returns A cipher text and an encapsulated key as bytes.
     * @throws {@link EncapError}, {@link MessageLimitReachedError}, {@link SealError}, {@link ValidationError}
     */
    async seal(params, pt, aad = EMPTY.buffer) {
      const ctx = await this.createSenderContext(params);
      return {
        ct: await ctx.seal(pt, aad),
        enc: ctx.enc
      };
    }
    /**
     * Decrypts a message from a sender.
     *
     * If the error occurred, throws `DecapError` | `DeserializeError` | `OpenError` | `ValidationError`.
     *
     * @param params A set of parameters for building a recipient encryption context.
     * @param ct An encrypted text as bytes to be decrypted.
     * @param aad Additional authenticated data as bytes fed by an application.
     * @returns A decrypted plain text as bytes.
     * @throws {@link DecapError}, {@link DeserializeError}, {@link OpenError}, {@link ValidationError}
     */
    async open(params, ct, aad = EMPTY.buffer) {
      const ctx = await this.createRecipientContext(params);
      return await ctx.open(ct, aad);
    }
    // private verifyPskInputs(mode: Mode, params: KeyScheduleParams) {
    //   const gotPsk = (params.psk !== undefined);
    //   const gotPskId = (params.psk !== undefined && params.psk.id.byteLength > 0);
    //   if (gotPsk !== gotPskId) {
    //     throw new Error('Inconsistent PSK inputs');
    //   }
    //   if (gotPsk && (mode === Mode.Base || mode === Mode.Auth)) {
    //     throw new Error('PSK input provided when not needed');
    //   }
    //   if (!gotPsk && (mode === Mode.Psk || mode === Mode.AuthPsk)) {
    //     throw new Error('Missing required PSK input');
    //   }
    //   return;
    // }
    async _keySchedule(mode, sharedSecret, params) {
      const pskId = params.psk === void 0 ? EMPTY : toUint8Array(params.psk.id);
      const pskIdHash = await this._kdf.labeledExtract(EMPTY, LABEL_PSK_ID_HASH, pskId);
      const info = params.info === void 0 ? EMPTY : toUint8Array(params.info);
      const infoHash = await this._kdf.labeledExtract(EMPTY, LABEL_INFO_HASH, info);
      const keyScheduleContext = new Uint8Array(1 + pskIdHash.byteLength + infoHash.byteLength);
      keyScheduleContext.set(new Uint8Array([mode]), 0);
      keyScheduleContext.set(new Uint8Array(pskIdHash), 1);
      keyScheduleContext.set(new Uint8Array(infoHash), 1 + pskIdHash.byteLength);
      const psk = params.psk === void 0 ? EMPTY : toUint8Array(params.psk.key);
      const ikm = this._kdf.buildLabeledIkm(LABEL_SECRET, psk);
      const exporterSecretInfo = this._kdf.buildLabeledInfo(LABEL_EXP, keyScheduleContext, this._kdf.hashSize);
      const exporterSecret = await this._kdf.extractAndExpand(sharedSecret, ikm, exporterSecretInfo, this._kdf.hashSize);
      if (this._aead.id === AeadId.ExportOnly) {
        return { aead: this._aead, exporterSecret };
      }
      const keyInfo = this._kdf.buildLabeledInfo(LABEL_KEY, keyScheduleContext, this._aead.keySize);
      const key = await this._kdf.extractAndExpand(sharedSecret, ikm, keyInfo, this._aead.keySize);
      const baseNonceInfo = this._kdf.buildLabeledInfo(LABEL_BASE_NONCE, keyScheduleContext, this._aead.nonceSize);
      const baseNonce = await this._kdf.extractAndExpand(sharedSecret, ikm, baseNonceInfo, this._aead.nonceSize);
      return {
        aead: this._aead,
        exporterSecret,
        key,
        baseNonce: new Uint8Array(baseNonce),
        seq: 0
      };
    }
    async _keyScheduleS(mode, sharedSecret, enc, params) {
      const res = await this._keySchedule(mode, sharedSecret, params);
      if (res.key === void 0) {
        return new SenderExporterContextImpl(this._api, this._kdf, res.exporterSecret, enc);
      }
      return new SenderContextImpl(this._api, this._kdf, res, enc);
    }
    async _keyScheduleR(mode, sharedSecret, params) {
      const res = await this._keySchedule(mode, sharedSecret, params);
      if (res.key === void 0) {
        return new RecipientExporterContextImpl(this._api, this._kdf, res.exporterSecret);
      }
      return new RecipientContextImpl(this._api, this._kdf, res);
    }
    _validateInputLength(params) {
      if (params.info !== void 0 && params.info.byteLength > INFO_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long info");
      }
      if (params.psk !== void 0) {
        if (params.psk.key.byteLength < MINIMUM_PSK_LENGTH) {
          throw new InvalidParamError(`PSK must have at least ${MINIMUM_PSK_LENGTH} bytes`);
        }
        if (params.psk.key.byteLength > INPUT_LENGTH_LIMIT) {
          throw new InvalidParamError("Too long psk.key");
        }
        if (params.psk.id.byteLength > INPUT_LENGTH_LIMIT) {
          throw new InvalidParamError("Too long psk.id");
        }
      }
      return;
    }
  };

  // node_modules/@hpke/core/esm/src/native.js
  var CipherSuite = class extends CipherSuiteNative {
  };

  // node_modules/@hpke/core/esm/src/kems/dhkemPrimitives/x25519.js
  var PKCS8_ALG_ID_X25519 = new Uint8Array([
    48,
    46,
    2,
    1,
    0,
    48,
    5,
    6,
    3,
    43,
    101,
    110,
    4,
    34,
    4,
    32
  ]);

  // node_modules/@hpke/core/esm/src/kems/dhkemPrimitives/x448.js
  var PKCS8_ALG_ID_X448 = new Uint8Array([
    48,
    70,
    2,
    1,
    0,
    48,
    5,
    6,
    3,
    43,
    101,
    111,
    4,
    58,
    4,
    56
  ]);

  // node_modules/@hpke/chacha20poly1305/esm/src/chacha/utils.js
  function abool(b2) {
    if (typeof b2 !== "boolean")
      throw new Error(`boolean expected, not ${b2}`);
  }
  var wrapCipher = /* @__NO_SIDE_EFFECTS__ */ (params, constructor) => {
    function wrappedCipher(key, ...args) {
      abytes(key, void 0, "key");
      if (!isLE2) {
        throw new Error("Non little-endian hardware is not yet supported");
      }
      if (params.nonceLength !== void 0) {
        const nonce = args[0];
        abytes(nonce, params.varSizeNonce ? void 0 : params.nonceLength, "nonce");
      }
      const tagl = params.tagLength;
      if (tagl && args[1] !== void 0)
        abytes(args[1], void 0, "AAD");
      const cipher = constructor(key, ...args);
      const checkOutput = (fnLength, output3) => {
        if (output3 !== void 0) {
          if (fnLength !== 2)
            throw new Error("cipher output not supported");
          abytes(output3, void 0, "output");
        }
      };
      let called = false;
      const wrCipher = {
        encrypt(data, output3) {
          if (called) {
            throw new Error("cannot encrypt() twice with same key + nonce");
          }
          called = true;
          abytes(data);
          checkOutput(cipher.encrypt.length, output3);
          return cipher.encrypt(data, output3);
        },
        decrypt(data, output3) {
          abytes(data);
          if (tagl && data.length < tagl) {
            throw new Error('"ciphertext" expected length bigger than tagLength=' + tagl);
          }
          checkOutput(cipher.decrypt.length, output3);
          return cipher.decrypt(data, output3);
        }
      };
      return wrCipher;
    }
    Object.assign(wrappedCipher, params);
    return wrappedCipher;
  };
  function checkOpts(defaults, opts) {
    if (opts == null || typeof opts !== "object") {
      throw new Error("options must be defined");
    }
    const merged = Object.assign(defaults, opts);
    return merged;
  }
  function equalBytes2(a, b2) {
    if (a.length !== b2.length)
      return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
      diff |= a[i] ^ b2[i];
    return diff === 0;
  }
  function getOutput(expectedLength, out, onlyAligned = true) {
    if (out === void 0)
      return new Uint8Array(expectedLength);
    if (out.length !== expectedLength) {
      throw new Error('"output" expected Uint8Array of length ' + expectedLength + ", got: " + out.length);
    }
    if (onlyAligned && !isAligned32(out)) {
      throw new Error("invalid output, must be aligned");
    }
    return out;
  }
  function u64Lengths(dataLength2, aadLength, isLE3) {
    abool(isLE3);
    const num = new Uint8Array(16);
    const view = createView2(num);
    view.setBigUint64(0, numberToBigint(aadLength), isLE3);
    view.setBigUint64(8, numberToBigint(dataLength2), isLE3);
    return num;
  }
  function isAligned32(bytes2) {
    return bytes2.byteOffset % 4 === 0;
  }

  // node_modules/@hpke/chacha20poly1305/esm/src/chacha/_arx.js
  var _utf8ToBytes = (str) => Uint8Array.from(str.split("").map((c) => c.charCodeAt(0)));
  var sigma16 = _utf8ToBytes("expand 16-byte k");
  var sigma32 = _utf8ToBytes("expand 32-byte k");
  var sigma16_32 = u322(sigma16);
  var sigma32_32 = u322(sigma32);
  function rotl(a, b2) {
    return a << b2 | a >>> 32 - b2;
  }
  function isAligned322(b2) {
    return b2.byteOffset % 4 === 0;
  }
  var BLOCK_LEN = 64;
  var BLOCK_LEN32 = 16;
  var MAX_COUNTER = 2 ** 32 - 1;
  var U32_EMPTY = Uint32Array.of();
  function runCipher(core, sigma, key, nonce, data, output3, counter, rounds) {
    const len = data.length;
    const block = new Uint8Array(BLOCK_LEN);
    const b32 = u322(block);
    const isAligned = isAligned322(data) && isAligned322(output3);
    const d32 = isAligned ? u322(data) : U32_EMPTY;
    const o32 = isAligned ? u322(output3) : U32_EMPTY;
    for (let pos = 0; pos < len; counter++) {
      core(sigma, key, nonce, b32, counter, rounds);
      if (counter >= MAX_COUNTER)
        throw new Error("arx: counter overflow");
      const take = Math.min(BLOCK_LEN, len - pos);
      if (isAligned && take === BLOCK_LEN) {
        const pos32 = pos / 4;
        if (pos % 4 !== 0)
          throw new Error("arx: invalid block position");
        for (let j = 0, posj; j < BLOCK_LEN32; j++) {
          posj = pos32 + j;
          o32[posj] = d32[posj] ^ b32[j];
        }
        pos += BLOCK_LEN;
        continue;
      }
      for (let j = 0, posj; j < take; j++) {
        posj = pos + j;
        output3[posj] = data[posj] ^ block[j];
      }
      pos += take;
    }
  }
  function createCipher(core, opts) {
    const { allowShortKeys, extendNonceFn, counterLength, counterRight, rounds } = checkOpts({
      allowShortKeys: false,
      counterLength: 8,
      counterRight: false,
      rounds: 20
    }, opts);
    if (typeof core !== "function")
      throw new Error("core must be a function");
    anumber(counterLength);
    anumber(rounds);
    abool(counterRight);
    abool(allowShortKeys);
    return (key, nonce, data, output3, counter = 0) => {
      abytes(key, void 0, "key");
      abytes(nonce, void 0, "nonce");
      abytes(data, void 0, "data");
      const len = data.length;
      if (output3 === void 0)
        output3 = new Uint8Array(len);
      abytes(output3, void 0, "output");
      anumber(counter);
      if (counter < 0 || counter >= MAX_COUNTER) {
        throw new Error("arx: counter overflow");
      }
      if (output3.length < len) {
        throw new Error(`arx: output (${output3.length}) is shorter than data (${len})`);
      }
      const toClean = [];
      const l = key.length;
      let k;
      let sigma;
      if (l === 32) {
        toClean.push(k = copyBytes(key));
        sigma = sigma32_32;
      } else if (l === 16 && allowShortKeys) {
        k = new Uint8Array(32);
        k.set(key);
        k.set(key, 16);
        sigma = sigma16_32;
        toClean.push(k);
      } else {
        abytes(key, 32, "arx key");
        throw new Error("invalid key size");
      }
      if (!isAligned322(nonce))
        toClean.push(nonce = copyBytes(nonce));
      const k32 = u322(k);
      if (extendNonceFn) {
        if (nonce.length !== 24) {
          throw new Error(`arx: extended nonce must be 24 bytes`);
        }
        extendNonceFn(sigma, k32, u322(nonce.subarray(0, 16)), k32);
        nonce = nonce.subarray(16);
      }
      const nonceNcLen = 16 - counterLength;
      if (nonceNcLen !== nonce.length) {
        throw new Error(`arx: nonce must be ${nonceNcLen} or 16 bytes`);
      }
      if (nonceNcLen !== 12) {
        const nc = new Uint8Array(12);
        nc.set(nonce, counterRight ? 0 : 12 - nonce.length);
        nonce = nc;
        toClean.push(nonce);
      }
      const n32 = u322(nonce);
      runCipher(core, sigma, k32, n32, data, output3, counter, rounds);
      clean(...toClean);
      return output3;
    };
  }

  // node_modules/@hpke/chacha20poly1305/esm/src/chacha/_poly1305.js
  function u8to16(a, i) {
    return a[i++] & 255 | (a[i++] & 255) << 8;
  }
  var Poly1305 = class {
    // Can be speed-up using BigUint64Array, at the cost of complexity
    constructor(key) {
      Object.defineProperty(this, "blockLen", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 16
      });
      Object.defineProperty(this, "outputLen", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 16
      });
      Object.defineProperty(this, "buffer", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: new Uint8Array(16)
      });
      Object.defineProperty(this, "r", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: new Uint16Array(10)
      });
      Object.defineProperty(this, "h", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: new Uint16Array(10)
      });
      Object.defineProperty(this, "pad", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: new Uint16Array(8)
      });
      Object.defineProperty(this, "pos", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0
      });
      Object.defineProperty(this, "finished", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: false
      });
      key = copyBytes(abytes(key, 32, "key"));
      const t0 = u8to16(key, 0);
      const t1 = u8to16(key, 2);
      const t2 = u8to16(key, 4);
      const t3 = u8to16(key, 6);
      const t4 = u8to16(key, 8);
      const t5 = u8to16(key, 10);
      const t6 = u8to16(key, 12);
      const t7 = u8to16(key, 14);
      this.r[0] = t0 & 8191;
      this.r[1] = (t0 >>> 13 | t1 << 3) & 8191;
      this.r[2] = (t1 >>> 10 | t2 << 6) & 7939;
      this.r[3] = (t2 >>> 7 | t3 << 9) & 8191;
      this.r[4] = (t3 >>> 4 | t4 << 12) & 255;
      this.r[5] = t4 >>> 1 & 8190;
      this.r[6] = (t4 >>> 14 | t5 << 2) & 8191;
      this.r[7] = (t5 >>> 11 | t6 << 5) & 8065;
      this.r[8] = (t6 >>> 8 | t7 << 8) & 8191;
      this.r[9] = t7 >>> 5 & 127;
      for (let i = 0; i < 8; i++)
        this.pad[i] = u8to16(key, 16 + 2 * i);
    }
    process(data, offset, isLast = false) {
      const hibit = isLast ? 0 : 1 << 11;
      const { h, r } = this;
      const r0 = r[0];
      const r1 = r[1];
      const r2 = r[2];
      const r3 = r[3];
      const r4 = r[4];
      const r5 = r[5];
      const r6 = r[6];
      const r7 = r[7];
      const r8 = r[8];
      const r9 = r[9];
      const t0 = u8to16(data, offset + 0);
      const t1 = u8to16(data, offset + 2);
      const t2 = u8to16(data, offset + 4);
      const t3 = u8to16(data, offset + 6);
      const t4 = u8to16(data, offset + 8);
      const t5 = u8to16(data, offset + 10);
      const t6 = u8to16(data, offset + 12);
      const t7 = u8to16(data, offset + 14);
      const h0 = h[0] + (t0 & 8191);
      const h1 = h[1] + ((t0 >>> 13 | t1 << 3) & 8191);
      const h2 = h[2] + ((t1 >>> 10 | t2 << 6) & 8191);
      const h3 = h[3] + ((t2 >>> 7 | t3 << 9) & 8191);
      const h4 = h[4] + ((t3 >>> 4 | t4 << 12) & 8191);
      const h5 = h[5] + (t4 >>> 1 & 8191);
      const h6 = h[6] + ((t4 >>> 14 | t5 << 2) & 8191);
      const h7 = h[7] + ((t5 >>> 11 | t6 << 5) & 8191);
      const h8 = h[8] + ((t6 >>> 8 | t7 << 8) & 8191);
      const h9 = h[9] + (t7 >>> 5 | hibit);
      let c = 0;
      let d0 = c + h0 * r0 + h1 * (5 * r9) + h2 * (5 * r8) + h3 * (5 * r7) + h4 * (5 * r6);
      c = d0 >>> 13;
      d0 &= 8191;
      d0 += h5 * (5 * r5) + h6 * (5 * r4) + h7 * (5 * r3) + h8 * (5 * r2) + h9 * (5 * r1);
      c += d0 >>> 13;
      d0 &= 8191;
      let d1 = c + h0 * r1 + h1 * r0 + h2 * (5 * r9) + h3 * (5 * r8) + h4 * (5 * r7);
      c = d1 >>> 13;
      d1 &= 8191;
      d1 += h5 * (5 * r6) + h6 * (5 * r5) + h7 * (5 * r4) + h8 * (5 * r3) + h9 * (5 * r2);
      c += d1 >>> 13;
      d1 &= 8191;
      let d2 = c + h0 * r2 + h1 * r1 + h2 * r0 + h3 * (5 * r9) + h4 * (5 * r8);
      c = d2 >>> 13;
      d2 &= 8191;
      d2 += h5 * (5 * r7) + h6 * (5 * r6) + h7 * (5 * r5) + h8 * (5 * r4) + h9 * (5 * r3);
      c += d2 >>> 13;
      d2 &= 8191;
      let d3 = c + h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * (5 * r9);
      c = d3 >>> 13;
      d3 &= 8191;
      d3 += h5 * (5 * r8) + h6 * (5 * r7) + h7 * (5 * r6) + h8 * (5 * r5) + h9 * (5 * r4);
      c += d3 >>> 13;
      d3 &= 8191;
      let d4 = c + h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
      c = d4 >>> 13;
      d4 &= 8191;
      d4 += h5 * (5 * r9) + h6 * (5 * r8) + h7 * (5 * r7) + h8 * (5 * r6) + h9 * (5 * r5);
      c += d4 >>> 13;
      d4 &= 8191;
      let d5 = c + h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1;
      c = d5 >>> 13;
      d5 &= 8191;
      d5 += h5 * r0 + h6 * (5 * r9) + h7 * (5 * r8) + h8 * (5 * r7) + h9 * (5 * r6);
      c += d5 >>> 13;
      d5 &= 8191;
      let d6 = c + h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2;
      c = d6 >>> 13;
      d6 &= 8191;
      d6 += h5 * r1 + h6 * r0 + h7 * (5 * r9) + h8 * (5 * r8) + h9 * (5 * r7);
      c += d6 >>> 13;
      d6 &= 8191;
      let d7 = c + h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3;
      c = d7 >>> 13;
      d7 &= 8191;
      d7 += h5 * r2 + h6 * r1 + h7 * r0 + h8 * (5 * r9) + h9 * (5 * r8);
      c += d7 >>> 13;
      d7 &= 8191;
      let d8 = c + h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4;
      c = d8 >>> 13;
      d8 &= 8191;
      d8 += h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * (5 * r9);
      c += d8 >>> 13;
      d8 &= 8191;
      let d9 = c + h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5;
      c = d9 >>> 13;
      d9 &= 8191;
      d9 += h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0;
      c += d9 >>> 13;
      d9 &= 8191;
      c = (c << 2) + c | 0;
      c = c + d0 | 0;
      d0 = c & 8191;
      c = c >>> 13;
      d1 += c;
      h[0] = d0;
      h[1] = d1;
      h[2] = d2;
      h[3] = d3;
      h[4] = d4;
      h[5] = d5;
      h[6] = d6;
      h[7] = d7;
      h[8] = d8;
      h[9] = d9;
    }
    finalize() {
      const { h, pad } = this;
      const g = new Uint16Array(10);
      let c = h[1] >>> 13;
      h[1] &= 8191;
      for (let i = 2; i < 10; i++) {
        h[i] += c;
        c = h[i] >>> 13;
        h[i] &= 8191;
      }
      h[0] += c * 5;
      c = h[0] >>> 13;
      h[0] &= 8191;
      h[1] += c;
      c = h[1] >>> 13;
      h[1] &= 8191;
      h[2] += c;
      g[0] = h[0] + 5;
      c = g[0] >>> 13;
      g[0] &= 8191;
      for (let i = 1; i < 10; i++) {
        g[i] = h[i] + c;
        c = g[i] >>> 13;
        g[i] &= 8191;
      }
      g[9] -= 1 << 13;
      let mask2 = (c ^ 1) - 1;
      for (let i = 0; i < 10; i++)
        g[i] &= mask2;
      mask2 = ~mask2;
      for (let i = 0; i < 10; i++)
        h[i] = h[i] & mask2 | g[i];
      h[0] = (h[0] | h[1] << 13) & 65535;
      h[1] = (h[1] >>> 3 | h[2] << 10) & 65535;
      h[2] = (h[2] >>> 6 | h[3] << 7) & 65535;
      h[3] = (h[3] >>> 9 | h[4] << 4) & 65535;
      h[4] = (h[4] >>> 12 | h[5] << 1 | h[6] << 14) & 65535;
      h[5] = (h[6] >>> 2 | h[7] << 11) & 65535;
      h[6] = (h[7] >>> 5 | h[8] << 8) & 65535;
      h[7] = (h[8] >>> 8 | h[9] << 5) & 65535;
      let f = h[0] + pad[0];
      h[0] = f & 65535;
      for (let i = 1; i < 8; i++) {
        f = (h[i] + pad[i] | 0) + (f >>> 16) | 0;
        h[i] = f & 65535;
      }
      clean(g);
    }
    update(data) {
      aexists(this);
      abytes(data);
      data = copyBytes(data);
      const { buffer, blockLen } = this;
      const len = data.length;
      for (let pos = 0; pos < len; ) {
        const take = Math.min(blockLen - this.pos, len - pos);
        if (take === blockLen) {
          for (; blockLen <= len - pos; pos += blockLen)
            this.process(data, pos);
          continue;
        }
        buffer.set(data.subarray(pos, pos + take), this.pos);
        this.pos += take;
        pos += take;
        if (this.pos === blockLen) {
          this.process(buffer, 0, false);
          this.pos = 0;
        }
      }
      return this;
    }
    destroy() {
      clean(this.h, this.r, this.buffer, this.pad);
    }
    digestInto(out) {
      aexists(this);
      aoutput(out, this);
      this.finished = true;
      const { buffer, h } = this;
      let { pos } = this;
      if (pos) {
        buffer[pos++] = 1;
        for (; pos < 16; pos++)
          buffer[pos] = 0;
        this.process(buffer, 0, true);
      }
      this.finalize();
      let opos = 0;
      for (let i = 0; i < 8; i++) {
        out[opos++] = h[i] >>> 0;
        out[opos++] = h[i] >>> 8;
      }
      return out;
    }
    digest() {
      const { buffer, outputLen } = this;
      this.digestInto(buffer);
      const res = buffer.slice(0, outputLen);
      this.destroy();
      return res;
    }
  };
  function wrapConstructorWithKey(hashCons) {
    const hashC = (msg, key) => hashCons(key).update(msg).digest();
    const tmp = hashCons(new Uint8Array(32));
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = (key) => hashCons(key);
    return hashC;
  }
  var poly1305 = /* @__PURE__ */ (() => wrapConstructorWithKey((key) => new Poly1305(key)))();

  // node_modules/@hpke/chacha20poly1305/esm/src/chacha/chacha.js
  function chachaCore(s, k, n2, out, cnt, rounds = 20) {
    const y00 = s[0], y01 = s[1], y02 = s[2], y03 = s[3], y04 = k[0], y05 = k[1], y06 = k[2], y07 = k[3], y08 = k[4], y09 = k[5], y10 = k[6], y11 = k[7], y12 = cnt, y13 = n2[0], y14 = n2[1], y15 = n2[2];
    let x00 = y00, x01 = y01, x02 = y02, x03 = y03, x04 = y04, x05 = y05, x06 = y06, x07 = y07, x08 = y08, x09 = y09, x10 = y10, x11 = y11, x12 = y12, x13 = y13, x14 = y14, x15 = y15;
    for (let r = 0; r < rounds; r += 2) {
      x00 = x00 + x04 | 0;
      x12 = rotl(x12 ^ x00, 16);
      x08 = x08 + x12 | 0;
      x04 = rotl(x04 ^ x08, 12);
      x00 = x00 + x04 | 0;
      x12 = rotl(x12 ^ x00, 8);
      x08 = x08 + x12 | 0;
      x04 = rotl(x04 ^ x08, 7);
      x01 = x01 + x05 | 0;
      x13 = rotl(x13 ^ x01, 16);
      x09 = x09 + x13 | 0;
      x05 = rotl(x05 ^ x09, 12);
      x01 = x01 + x05 | 0;
      x13 = rotl(x13 ^ x01, 8);
      x09 = x09 + x13 | 0;
      x05 = rotl(x05 ^ x09, 7);
      x02 = x02 + x06 | 0;
      x14 = rotl(x14 ^ x02, 16);
      x10 = x10 + x14 | 0;
      x06 = rotl(x06 ^ x10, 12);
      x02 = x02 + x06 | 0;
      x14 = rotl(x14 ^ x02, 8);
      x10 = x10 + x14 | 0;
      x06 = rotl(x06 ^ x10, 7);
      x03 = x03 + x07 | 0;
      x15 = rotl(x15 ^ x03, 16);
      x11 = x11 + x15 | 0;
      x07 = rotl(x07 ^ x11, 12);
      x03 = x03 + x07 | 0;
      x15 = rotl(x15 ^ x03, 8);
      x11 = x11 + x15 | 0;
      x07 = rotl(x07 ^ x11, 7);
      x00 = x00 + x05 | 0;
      x15 = rotl(x15 ^ x00, 16);
      x10 = x10 + x15 | 0;
      x05 = rotl(x05 ^ x10, 12);
      x00 = x00 + x05 | 0;
      x15 = rotl(x15 ^ x00, 8);
      x10 = x10 + x15 | 0;
      x05 = rotl(x05 ^ x10, 7);
      x01 = x01 + x06 | 0;
      x12 = rotl(x12 ^ x01, 16);
      x11 = x11 + x12 | 0;
      x06 = rotl(x06 ^ x11, 12);
      x01 = x01 + x06 | 0;
      x12 = rotl(x12 ^ x01, 8);
      x11 = x11 + x12 | 0;
      x06 = rotl(x06 ^ x11, 7);
      x02 = x02 + x07 | 0;
      x13 = rotl(x13 ^ x02, 16);
      x08 = x08 + x13 | 0;
      x07 = rotl(x07 ^ x08, 12);
      x02 = x02 + x07 | 0;
      x13 = rotl(x13 ^ x02, 8);
      x08 = x08 + x13 | 0;
      x07 = rotl(x07 ^ x08, 7);
      x03 = x03 + x04 | 0;
      x14 = rotl(x14 ^ x03, 16);
      x09 = x09 + x14 | 0;
      x04 = rotl(x04 ^ x09, 12);
      x03 = x03 + x04 | 0;
      x14 = rotl(x14 ^ x03, 8);
      x09 = x09 + x14 | 0;
      x04 = rotl(x04 ^ x09, 7);
    }
    let oi = 0;
    out[oi++] = y00 + x00 | 0;
    out[oi++] = y01 + x01 | 0;
    out[oi++] = y02 + x02 | 0;
    out[oi++] = y03 + x03 | 0;
    out[oi++] = y04 + x04 | 0;
    out[oi++] = y05 + x05 | 0;
    out[oi++] = y06 + x06 | 0;
    out[oi++] = y07 + x07 | 0;
    out[oi++] = y08 + x08 | 0;
    out[oi++] = y09 + x09 | 0;
    out[oi++] = y10 + x10 | 0;
    out[oi++] = y11 + x11 | 0;
    out[oi++] = y12 + x12 | 0;
    out[oi++] = y13 + x13 | 0;
    out[oi++] = y14 + x14 | 0;
    out[oi++] = y15 + x15 | 0;
  }
  var chacha20 = /* @__PURE__ */ createCipher(chachaCore, {
    counterRight: false,
    counterLength: 4,
    allowShortKeys: false
  });
  var ZEROS16 = /* @__PURE__ */ new Uint8Array(16);
  var updatePadded = (h, msg) => {
    h.update(msg);
    const leftover = msg.length % 16;
    if (leftover)
      h.update(ZEROS16.subarray(leftover));
  };
  var ZEROS32 = /* @__PURE__ */ new Uint8Array(32);
  function computeTag(fn, key, nonce, ciphertext, AAD) {
    if (AAD !== void 0)
      abytes(AAD, void 0, "AAD");
    const authKey = fn(key, nonce, ZEROS32);
    const lengths = u64Lengths(ciphertext.length, AAD ? AAD.length : 0, true);
    const h = poly1305.create(authKey);
    if (AAD)
      updatePadded(h, AAD);
    updatePadded(h, ciphertext);
    h.update(lengths);
    const res = h.digest();
    clean(authKey, lengths);
    return res;
  }
  var _poly1305_aead = (xorStream) => (key, nonce, AAD) => {
    const tagLength = 16;
    return {
      encrypt(plaintext, output3) {
        const plength = plaintext.length;
        output3 = getOutput(plength + tagLength, output3, false);
        output3.set(plaintext);
        const oPlain = output3.subarray(0, -tagLength);
        xorStream(key, nonce, oPlain, oPlain, 1);
        const tag = computeTag(xorStream, key, nonce, oPlain, AAD);
        output3.set(tag, plength);
        clean(tag);
        return output3;
      },
      decrypt(ciphertext, output3) {
        output3 = getOutput(ciphertext.length - tagLength, output3, false);
        const data = ciphertext.subarray(0, -tagLength);
        const passedTag = ciphertext.subarray(-tagLength);
        const tag = computeTag(xorStream, key, nonce, data, AAD);
        if (!equalBytes2(passedTag, tag))
          throw new Error("invalid tag");
        output3.set(ciphertext.subarray(0, -tagLength));
        xorStream(key, nonce, output3, output3, 1);
        clean(tag);
        return output3;
      }
    };
  };
  var chacha20poly1305 = /* @__PURE__ */ wrapCipher({ blockSize: 64, nonceLength: 12, tagLength: 16 }, _poly1305_aead(chacha20));

  // node_modules/@hpke/chacha20poly1305/esm/src/chacha20Poly1305.js
  var Chacha20Poly1305Context = class {
    constructor(key) {
      Object.defineProperty(this, "_key", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this._key = new Uint8Array(toArrayBuffer(key));
    }
    async seal(iv, data, aad) {
      return await this._seal(toArrayBuffer(iv), toArrayBuffer(data), toArrayBuffer(aad));
    }
    async open(iv, data, aad) {
      return await this._open(toArrayBuffer(iv), toArrayBuffer(data), toArrayBuffer(aad));
    }
    _seal(iv, data, aad) {
      return new Promise((resolve) => {
        const ret = chacha20poly1305(this._key, new Uint8Array(iv), new Uint8Array(aad)).encrypt(new Uint8Array(data));
        resolve(ret.buffer);
      });
    }
    _open(iv, data, aad) {
      return new Promise((resolve) => {
        const ret = chacha20poly1305(this._key, new Uint8Array(iv), new Uint8Array(aad)).decrypt(new Uint8Array(data));
        resolve(ret.buffer);
      });
    }
  };
  var Chacha20Poly1305 = class {
    constructor() {
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: AeadId.Chacha20Poly1305
      });
      Object.defineProperty(this, "keySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32
      });
      Object.defineProperty(this, "nonceSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 12
      });
      Object.defineProperty(this, "tagSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 16
      });
    }
    createEncryptionContext(key) {
      return new Chacha20Poly1305Context(key);
    }
  };

  // node_modules/@hpke/dhkem-x25519/esm/src/primitives/x25519.js
  var _1n8 = 1n;
  var _2n7 = 2n;
  var _3n3 = 3n;
  var _5n2 = 5n;
  var ed25519_CURVE_p = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn;
  function ed25519_pow_2_252_3(x) {
    const _10n = 10n;
    const _20n = 20n;
    const _40n = 40n;
    const _80n = 80n;
    const P = ed25519_CURVE_p;
    const x2 = x * x % P;
    const b2 = x2 * x % P;
    const b4 = pow22(b2, _2n7, P) * b2 % P;
    const b5 = pow22(b4, _1n8, P) * x % P;
    const b10 = pow22(b5, _5n2, P) * b5 % P;
    const b20 = pow22(b10, _10n, P) * b10 % P;
    const b40 = pow22(b20, _20n, P) * b20 % P;
    const b80 = pow22(b40, _40n, P) * b40 % P;
    const b160 = pow22(b80, _80n, P) * b80 % P;
    const b240 = pow22(b160, _80n, P) * b80 % P;
    const b250 = pow22(b240, _10n, P) * b10 % P;
    const pow_p_5_8 = pow22(b250, _2n7, P) * x % P;
    return { pow_p_5_8, b2 };
  }
  function adjustScalarBytes(bytes2) {
    bytes2[0] &= 248;
    bytes2[31] &= 127;
    bytes2[31] |= 64;
    return bytes2;
  }
  var x25519 = /* @__PURE__ */ (() => {
    const P = ed25519_CURVE_p;
    return montgomery({
      P,
      type: "x25519",
      powPminus2: (x) => {
        const { pow_p_5_8, b2 } = ed25519_pow_2_252_3(x);
        return mod3(pow22(pow_p_5_8, _3n3, P) * b2, P);
      },
      adjustScalarBytes
    });
  })();

  // node_modules/@hpke/dhkem-x25519/esm/src/hkdfSha256.js
  var HkdfSha2562 = class extends HkdfSha256Native {
    async extract(salt, ikm) {
      await this._setup();
      const saltBuf = salt.byteLength === 0 ? new ArrayBuffer(this.hashSize) : toArrayBuffer(salt);
      const ikmBuf = toArrayBuffer(ikm);
      if (saltBuf.byteLength !== this.hashSize) {
        return hmac2(sha2563, new Uint8Array(saltBuf), new Uint8Array(ikmBuf)).buffer;
      }
      const key = await this._api.importKey("raw", saltBuf, this.algHash, false, [
        "sign"
      ]);
      return await this._api.sign("HMAC", key, ikmBuf);
    }
  };

  // node_modules/@hpke/dhkem-x25519/esm/src/dhkemX25519.js
  var X255192 = class extends XCurveDhkemPrimitives {
    constructor(hkdf) {
      super("X25519", 32, x25519, hkdf);
    }
    derive(sk, pk) {
      try {
        return Promise.resolve(this._curve.getSharedSecret(sk, pk));
      } catch (e) {
        return Promise.reject(new SerializeError(e));
      }
    }
  };
  var DhkemX25519HkdfSha2562 = class extends Dhkem {
    constructor() {
      const kdf = new HkdfSha2562();
      super(KemId.DhkemX25519HkdfSha256, new X255192(kdf), kdf);
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: KemId.DhkemX25519HkdfSha256
      });
      Object.defineProperty(this, "secretSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32
      });
      Object.defineProperty(this, "encSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32
      });
      Object.defineProperty(this, "publicKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32
      });
      Object.defineProperty(this, "privateKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32
      });
    }
  };

  // node_modules/@hpke/dhkem-x448/esm/src/primitives/x448.js
  var ed448_CURVE_p = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
  var _1n9 = 1n;
  var _2n8 = 2n;
  var _3n4 = 3n;
  var _11n = 11n;
  var _22n = 22n;
  var _44n = 44n;
  var _88n = 88n;
  var _223n = 223n;
  function ed448_pow_Pminus3div4(x) {
    const P = ed448_CURVE_p;
    const b2 = x * x * x % P;
    const b3 = b2 * b2 * x % P;
    const b6 = pow22(b3, _3n4, P) * b3 % P;
    const b9 = pow22(b6, _3n4, P) * b3 % P;
    const b11 = pow22(b9, _2n8, P) * b2 % P;
    const b22 = pow22(b11, _11n, P) * b11 % P;
    const b44 = pow22(b22, _22n, P) * b22 % P;
    const b88 = pow22(b44, _44n, P) * b44 % P;
    const b176 = pow22(b88, _88n, P) * b88 % P;
    const b220 = pow22(b176, _44n, P) * b44 % P;
    const b222 = pow22(b220, _2n8, P) * b2 % P;
    const b223 = pow22(b222, _1n9, P) * x % P;
    return pow22(b223, _223n, P) * b222 % P;
  }
  function adjustScalarBytes2(bytes2) {
    bytes2[0] &= 252;
    bytes2[55] |= 128;
    bytes2[56] = 0;
    return bytes2;
  }
  var x448 = /* @__PURE__ */ (() => {
    const P = ed448_CURVE_p;
    return montgomery({
      P,
      type: "x448",
      powPminus2: (x) => {
        const Pminus3div4 = ed448_pow_Pminus3div4(x);
        const Pminus3 = pow22(Pminus3div4, _2n8, P);
        return mod3(Pminus3 * x, P);
      },
      adjustScalarBytes: adjustScalarBytes2
    });
  })();

  // node_modules/@hpke/dhkem-x448/esm/src/hkdfSha512.js
  var HkdfSha5122 = class extends HkdfSha512Native {
    async extract(salt, ikm) {
      await this._setup();
      const saltBuf = salt.byteLength === 0 ? new ArrayBuffer(this.hashSize) : toArrayBuffer(salt);
      const ikmBuf = toArrayBuffer(ikm);
      if (saltBuf.byteLength !== this.hashSize) {
        return hmac2(sha5123, new Uint8Array(saltBuf), new Uint8Array(ikmBuf)).buffer;
      }
      const key = await this._api.importKey("raw", saltBuf, this.algHash, false, [
        "sign"
      ]);
      return await this._api.sign("HMAC", key, ikmBuf);
    }
  };

  // node_modules/@hpke/dhkem-x448/esm/src/dhkemX448.js
  var X4482 = class extends XCurveDhkemPrimitives {
    constructor(hkdf) {
      super("X448", 56, x448, hkdf);
    }
  };
  var DhkemX448HkdfSha5122 = class extends Dhkem {
    constructor() {
      const kdf = new HkdfSha5122();
      super(KemId.DhkemX448HkdfSha512, new X4482(kdf), kdf);
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: KemId.DhkemX448HkdfSha512
      });
      Object.defineProperty(this, "secretSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 64
      });
      Object.defineProperty(this, "encSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 56
      });
      Object.defineProperty(this, "publicKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 56
      });
      Object.defineProperty(this, "privateKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 56
      });
    }
  };

  // node_modules/hpke-js/esm/src/kdfs/hkdfSha384.js
  var HkdfSha3842 = class extends HkdfSha384Native {
    async extract(salt, ikm) {
      await this._setup();
      const saltBuf = salt.byteLength === 0 ? new ArrayBuffer(this.hashSize) : toArrayBuffer(salt);
      const ikmBuf = toArrayBuffer(ikm);
      if (saltBuf.byteLength !== this.hashSize) {
        return hmac2(sha384, new Uint8Array(saltBuf), new Uint8Array(ikmBuf)).buffer;
      }
      const key = await this._api.importKey("raw", saltBuf, this.algHash, false, [
        "sign"
      ]);
      return await this._api.sign("HMAC", key, ikmBuf);
    }
  };

  // node_modules/hpke-js/esm/src/kems/dhkemP256.js
  var DhkemP256HkdfSha2562 = class extends Dhkem {
    constructor() {
      const kdf = new HkdfSha2562();
      const prim = new Ec(KemId.DhkemP256HkdfSha256, kdf);
      super(KemId.DhkemP256HkdfSha256, prim, kdf);
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: KemId.DhkemP256HkdfSha256
      });
      Object.defineProperty(this, "secretSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32
      });
      Object.defineProperty(this, "encSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 65
      });
      Object.defineProperty(this, "publicKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 65
      });
      Object.defineProperty(this, "privateKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32
      });
    }
  };

  // node_modules/hpke-js/esm/src/kems/dhkemP384.js
  var DhkemP384HkdfSha3842 = class extends Dhkem {
    constructor() {
      const kdf = new HkdfSha3842();
      const prim = new Ec(KemId.DhkemP384HkdfSha384, kdf);
      super(KemId.DhkemP384HkdfSha384, prim, kdf);
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: KemId.DhkemP384HkdfSha384
      });
      Object.defineProperty(this, "secretSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 48
      });
      Object.defineProperty(this, "encSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 97
      });
      Object.defineProperty(this, "publicKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 97
      });
      Object.defineProperty(this, "privateKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 48
      });
    }
  };

  // node_modules/hpke-js/esm/src/kems/dhkemP521.js
  var DhkemP521HkdfSha5122 = class extends Dhkem {
    constructor() {
      const kdf = new HkdfSha5122();
      const prim = new Ec(KemId.DhkemP521HkdfSha512, kdf);
      super(KemId.DhkemP521HkdfSha512, prim, kdf);
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: KemId.DhkemP521HkdfSha512
      });
      Object.defineProperty(this, "secretSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 64
      });
      Object.defineProperty(this, "encSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 133
      });
      Object.defineProperty(this, "publicKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 133
      });
      Object.defineProperty(this, "privateKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 64
      });
    }
  };

  // node_modules/hpke-js/esm/src/cipherSuite.js
  var CipherSuite2 = class extends CipherSuite {
    /**
     * @param params A set of parameters for building a cipher suite.
     * @throws {@link InvalidParamError}
     */
    constructor(params) {
      if (typeof params.kem === "number") {
        switch (params.kem) {
          case KemId.DhkemP256HkdfSha256:
            params.kem = new DhkemP256HkdfSha2562();
            break;
          case KemId.DhkemP384HkdfSha384:
            params.kem = new DhkemP384HkdfSha3842();
            break;
          case KemId.DhkemP521HkdfSha512:
            params.kem = new DhkemP521HkdfSha5122();
            break;
          case KemId.DhkemX25519HkdfSha256:
            params.kem = new DhkemX25519HkdfSha2562();
            break;
          case KemId.DhkemX448HkdfSha512:
            params.kem = new DhkemX448HkdfSha5122();
            break;
          default:
            throw new InvalidParamError(`The KEM (${params.kem}) cannot be specified by KemId. Use submodule for the KEM`);
        }
      }
      if (typeof params.kdf === "number") {
        switch (params.kdf) {
          case KdfId.HkdfSha256:
            params.kdf = new HkdfSha2562();
            break;
          case KdfId.HkdfSha384:
            params.kdf = new HkdfSha3842();
            break;
          default:
            params.kdf = new HkdfSha5122();
            break;
        }
      }
      if (typeof params.aead === "number") {
        switch (params.aead) {
          case AeadId.Aes128Gcm:
            params.aead = new Aes128Gcm();
            break;
          case AeadId.Aes256Gcm:
            params.aead = new Aes256Gcm();
            break;
          case AeadId.Chacha20Poly1305:
            params.aead = new Chacha20Poly1305();
            break;
          default:
            params.aead = new ExportOnly();
            break;
        }
      }
      super(params);
    }
    /**
     * Generates a key pair for the cipher suite.
     *
     * If the error occurred, throws {@link NotSupportedError}.
     *
     * @deprecated Use {@link KemInterface.generateKeyPair} instead.
     *
     * @returns A key pair generated.
     * @throws {@link NotSupportedError}
     */
    async generateKeyPair() {
      await this._setup();
      return await this._kem.generateKeyPair();
    }
    /**
     * Derives a key pair for the cipher suite in the manner
     * defined in [RFC9180 Section 7.1.3](https://www.rfc-editor.org/rfc/rfc9180.html#section-7.1.3).
     *
     * If the error occurred, throws {@link DeriveKeyPairError}.
     *
     * @deprecated Use {@link KemInterface.deriveKeyPair} instead.
     *
     * @param ikm A byte string of input keying material. The maximum length is 128 bytes.
     * @returns A key pair derived.
     * @throws {@link DeriveKeyPairError}
     */
    async deriveKeyPair(ikm) {
      await this._setup();
      return await this._kem.deriveKeyPair(ikm);
    }
    /**
     * Imports a public or private key and converts to a {@link CryptoKey}.
     *
     * Since key parameters for {@link createSenderContext} or {@link createRecipientContext}
     * are {@link CryptoKey} format, you have to use this function to convert provided keys
     * to {@link CryptoKey}.
     *
     * Basically, this is a thin wrapper function of
     * [SubtleCrypto.importKey](https://www.w3.org/TR/WebCryptoAPI/#dfn-SubtleCrypto-method-importKey).
     *
     * If the error occurred, throws {@link DeserializeError}.
     *
     * @deprecated Use {@link KemInterface.generateKeyPair} instead.
     *
     * @param format For now, `'raw'` and `'jwk'` are supported.
     * @param key A byte string of a raw key or A {@link JsonWebKey} object.
     * @param isPublic The indicator whether the provided key is a public key or not, which is used only for `'raw'` format.
     * @returns A public or private CryptoKey.
     * @throws {@link DeserializeError}
     */
    async importKey(format, key, isPublic = true) {
      await this._setup();
      return await this._kem.importKey(format, key, isPublic);
    }
  };

  // hpke-core.mjs
  var POOL = "0x0000000000000000000000000000000000000001";
  var Q = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  var M = 1n << 64n;
  var U8 = (hex) => Uint8Array.from(hex.slice(2).match(/../g), (v) => parseInt(v, 16));
  var HEX = (bytes2) => `0x${Array.from(bytes2, (b2) => b2.toString(16).padStart(2, "0")).join("")}`;
  var SUITE = new CipherSuite2({ kem: KemId.DhkemX25519HkdfSha256, kdf: KdfId.HkdfSha256, aead: AeadId.Chacha20Poly1305 });
  var ABI = AbiCoder.defaultAbiCoder();
  var HKDF_SALT = U8(sha2562(toUtf8Bytes("ecu/uniswap/key-root/hkdf-salt/v1")));
  var HKDF_INFO = toUtf8Bytes("ecu/uniswap/recipient-ikm/v1");
  var INFO_TAG = keccak256(toUtf8Bytes("ecu/hpke-info/v1"));
  function messageFor(owner, chainId) {
    return [
      "ECU Uniswap recipient-key reproducibility probe v1",
      "This signature is secret key material. Never share it.",
      "Purpose: ecu/uniswap/key-root/v1",
      `ChainId: ${BigInt(chainId).toString(10)}`,
      `Pool: ${POOL}`,
      `Owner: ${getAddress(owner).toLowerCase()}`
    ].join("\n");
  }
  function canonicalSignature(signature, message, owner) {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Invalid signature length or encoding");
    const bytes2 = U8(signature);
    if (bytes2[64] !== 27 && bytes2[64] !== 28) throw new Error("Noncanonical recovery byte");
    const s = BigInt(`0x${HEX(bytes2.slice(32, 64)).slice(2)}`);
    const n2 = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    if (s < 1n || s > n2 / 2n) throw new Error("Noncanonical signature s");
    if (recoverAddress(hashMessage(toUtf8Bytes(message)), signature) !== getAddress(owner)) throw new Error("Signature owner mismatch");
    return bytes2;
  }
  async function recipientFromSignature(owner, chainId, signature) {
    const message = messageFor(owner, chainId);
    const bytes2 = canonicalSignature(signature, message, owner);
    let ikm;
    try {
      const base = await crypto.subtle.importKey("raw", bytes2, "HKDF", false, ["deriveBits"]);
      ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO }, base, 256));
      const keyPair = await SUITE.kem.deriveKeyPair(ikm);
      const publicKey = new Uint8Array(await SUITE.kem.serializePublicKey(keyPair.publicKey));
      if (publicKey.length !== 32) throw new Error("Unexpected recipient public key");
      return { keyPair, publicKey: HEX(publicKey) };
    } finally {
      bytes2.fill(0);
      ikm?.fill(0);
    }
  }
  function boundedRandom(maxExclusive, byteLength) {
    for (; ; ) {
      const raw = crypto.getRandomValues(new Uint8Array(byteLength));
      const value = BigInt(HEX(raw));
      raw.fill(0);
      if (value < maxExclusive) return value;
    }
  }
  function encode32(value) {
    return U8(`0x${value.toString(16).padStart(64, "0")}`);
  }
  function infoFor(chainId, owner, salt) {
    return U8(keccak256(ABI.encode(
      ["bytes32", "uint256", "address", "uint8", "bytes32", "uint256", "address", "uint256", "uint256", "uint8"],
      [INFO_TAG, BigInt(chainId), POOL, 1, salt, 0, owner, 1, 2, 1]
    )));
  }
  async function createEnvelope(owner, chainId, recipient) {
    const salt = HEX(crypto.getRandomValues(new Uint8Array(32)));
    const info = infoFor(chainId, owner, salt);
    const v = boundedRandom(M, 8) + 1n;
    const r = boundedRandom(Q, 32);
    const plaintext = new Uint8Array(64);
    plaintext.set(encode32(v));
    plaintext.set(encode32(r), 32);
    try {
      const { enc, ct } = await SUITE.seal({ recipientPublicKey: recipient.keyPair.publicKey, info }, plaintext, new Uint8Array());
      const packet = new Uint8Array(112);
      if (enc.byteLength !== 32 || ct.byteLength !== 80) throw new Error("Unexpected HPKE length");
      packet.set(new Uint8Array(enc));
      packet.set(new Uint8Array(ct), 32);
      return { format: 1, owner: getAddress(owner).toLowerCase(), chainId: BigInt(chainId).toString(10), pool: POOL, recipientPublicKey: recipient.publicKey, kind: 1, salt, outputIndex: 0, Cx: "1", Cy: "2", packet: HEX(packet) };
    } finally {
      plaintext.fill(0);
    }
  }
  async function openEnvelope(envelope, owner, chainId, recipient) {
    if (envelope?.format !== 1 || envelope?.owner !== getAddress(owner).toLowerCase() || envelope?.chainId !== BigInt(chainId).toString(10) || envelope?.pool !== POOL || envelope?.recipientPublicKey !== recipient.publicKey || envelope?.kind !== 1 || envelope?.outputIndex !== 0 || envelope?.Cx !== "1" || envelope?.Cy !== "2") throw new Error("Public context or recipient key mismatch");
    if (!/^0x[0-9a-fA-F]{64}$/.test(envelope.salt) || !/^0x[0-9a-fA-F]{224}$/.test(envelope.packet)) throw new Error("Invalid public envelope encoding");
    const packet = U8(envelope.packet);
    const info = infoFor(chainId, owner, envelope.salt);
    const plaintext = new Uint8Array(await SUITE.open({ recipientKey: recipient.keyPair.privateKey, enc: packet.slice(0, 32), info }, packet.slice(32), new Uint8Array()));
    try {
      if (plaintext.length !== 64) throw new Error("Invalid plaintext length");
      const v = BigInt(HEX(plaintext.slice(0, 32)));
      const r = BigInt(HEX(plaintext.slice(32)));
      if (v < 1n || v > M || r >= Q) throw new Error("Invalid receipt scalar range");
    } finally {
      plaintext.fill(0);
    }
    packet[111] ^= 1;
    let tamperingRejected = false;
    try {
      await SUITE.open({ recipientKey: recipient.keyPair.privateKey, enc: packet.slice(0, 32), info }, packet.slice(32), new Uint8Array());
    } catch {
      tamperingRejected = true;
    }
    if (!tamperingRejected) throw new Error("Tampered packet accepted");
    return { recipientPublicKey: recipient.publicKey, packetBytes: 112, decryptedFormatAndRangeValid: true, tamperingRejected: true, commitmentAndHistoryChecked: false };
  }

  // hpke-probe.mjs
  var output2 = document.querySelector("#result");
  var envelopeInput = document.querySelector("#envelope");
  var makeButton = document.querySelector("#make");
  var openButton = document.querySelector("#open");
  async function sign() {
    if (!window.ethereum?.request) throw new Error("MetaMask provider unavailable");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    if (!Array.isArray(accounts) || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0])) throw new Error("No EOA selected");
    const owner = accounts[0].toLowerCase();
    const chainId = BigInt(await window.ethereum.request({ method: "eth_chainId" })).toString(10);
    const message = messageFor(owner, chainId);
    const bytes2 = new TextEncoder().encode(message);
    const hex = `0x${Array.from(bytes2, (b2) => b2.toString(16).padStart(2, "0")).join("")}`;
    const signature = await window.ethereum.request({ method: "personal_sign", params: [hex, owner] });
    return { owner, chainId, signature };
  }
  async function run(action) {
    makeButton.disabled = openButton.disabled = true;
    output2.textContent = "Waiting for MetaMask and local cryptography\u2026";
    try {
      await action();
    } catch (error) {
      output2.textContent = `No result. Error class: ${String(error?.name ?? "Error")}`;
    } finally {
      makeButton.disabled = openButton.disabled = false;
    }
  }
  makeButton.addEventListener("click", () => run(async () => {
    const { owner, chainId, signature } = await sign();
    const recipient = await recipientFromSignature(owner, chainId, signature);
    const envelope = await createEnvelope(owner, chainId, recipient);
    envelopeInput.value = JSON.stringify(envelope, null, 2);
    output2.textContent = JSON.stringify({ role: "profile A", owner, chainId, recipientPublicKey: recipient.publicKey, publicEnvelopeReady: true, packetBytes: 112, privateDataExported: false }, null, 2);
  }));
  openButton.addEventListener("click", () => run(async () => {
    if (envelopeInput.value.length > 4096) throw new Error("Oversized public envelope");
    const envelope = JSON.parse(envelopeInput.value);
    const { owner, chainId, signature } = await sign();
    const recipient = await recipientFromSignature(owner, chainId, signature);
    const result = await openEnvelope(envelope, owner, chainId, recipient);
    output2.textContent = JSON.stringify({ role: "profile B", owner, chainId, ...result }, null, 2);
  }));
})();
/*! Bundled license information:

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/utils.js:
@noble/curves/esm/abstract/modular.js:
@noble/curves/esm/abstract/curve.js:
@noble/curves/esm/abstract/weierstrass.js:
@noble/curves/esm/_shortw_utils.js:
@noble/curves/esm/secp256k1.js:
@hpke/common/esm/src/curve/modular.js:
@hpke/common/esm/src/curve/montgomery.js:
@hpke/dhkem-x25519/esm/src/primitives/x25519.js:
@hpke/dhkem-x448/esm/src/primitives/x448.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
