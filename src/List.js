import { List, IntegerList, StringList, BooleanList, NumberList } from "bioconductor";
import { H5Group, H5DataSet } from "./h5.js";
import { readObject, readObjectFile, saveObject } from "./general.js";
import { joinPath, exceedsInt32 } from "./utils.js";

function load_number(x) {
    if (x === "NaN") {
        return Number.NaN;
    } else if (x === "Inf") {
        return Number.POSITIVE_INFINITY;
    } else if (x === "-Inf") {
        return Number.NEGATIVE_INFINITY;
    } else {
        return x;
    }
}

function load_vector(x, constructor, options, typedarray) {
    let vals = x.values;
    let scalar = false;
    if (!(vals instanceof Array)) {
        vals = [vals];
        scalar = true;
    }
    let output = constructor(vals);
    if ("names" in x) {
        output.setNames(x.names, { inPlace: true });
    } else {
        if (scalar) {
            if ("List_toScalar" in options && options.List_toScalar) {
                return output.get(0);
            }
        } else if (typedarray !== null && output.toArray().every(y => y !== null)) {
            if ("List_toTypedArray" in options && options.List_toTypedArray) {
                return new typedarray(output.toArray());
            }
        }
    }
    output._jaspalite_scalar = scalar;
    return output;
}

async function load_json_list(x, path, globals, options) {
    if (x.type == "list") {
        let contents = [];
        for (const y of x.values) {
            contents.push(await load_json_list(y, path, globals, options));
        }
        let output = new List(contents);
        if ("names" in x) {
            output.setNames(x.names, { inPlace: true });
        }
        return output;

    } else if (x.type == "integer") {
        return load_vector(x, v => new IntegerList(v), options, Int32Array);

    } else if (x.type == "number") {
        return load_vector(x, v => new NumberList(v.map(load_number)), options, Float64Array);

    } else if (x.type == "string") {
        return load_vector(x, v => new StringList(v), options, null);

    } else if (x.type == "boolean") {
        return load_vector(x, v => new BooleanList(v), options, null);

    } else if (x.type == "factor") {
        // Whatever, just turn it into a StringList.
        return load_vector(
            x,
            v => {
                let copy = v.slice();
                for (var i = 0; i < copy.length; i++) {
                    if (copy[i] !== null) {
                        copy[i] = x.levels[copy[i]];
                    }
                }
                return new StringList(copy);
            },
            options,
            null
        );

    } else if (x.type == "nothing") {
        return null;

    } else if (x.type == "external") {
        return readObject(joinPath(path, "other_contents", String(x.index)), null, globals, options);

    } else {
        throw new Error("unknown JSON list type '" + x.type + "'");
    }
}

/**
 * An R-style list that allows access by name or index. 
 * @external List 
 * @see {@link https://ltla.github.io/bioconductor.js/List.html}
 */

/**
 * @param {string} path - Path to the takane-formatted object directory containing the {@link external:List List}.
 * @param {object} metadata - Takane object metadata, typically generated by calling {@linkcode readObjectFile} on `path`.
 * @param {object} globals - Object satisfying the {@link GlobalsInterface}.
 * @param {object} [options={}] - Further options.
 * @param {boolean} [options.List_toScalar=false] - Whether to report unnamed scalars as Javascript scalars. 
 * Integers are automatically converted to floating-point.
 * If `false`, scalars are reported as instances of an appropriately-typed {@link List} subclass with length 1 and a `_jaspalite_scalar` property.
 * @param {boolean} [options.List_toTypedArray=false] - Whether to report unnamed integer/number vectors without missing values as TypedArrays.
 * If `false`, such vectors are reported as instances of an appropriately-typed {@link List} subclass.
 *
 * @return {external:List} The list.
 * @async
 */
export async function readList(path, metadata, globals, options = {}) {
    if (metadata.simple_list.format !== "json.gz") {
        throw new Error("list formats other than 'json.gz' are currently not supported");
    }
    let contents = await globals.get(joinPath(path, "list_contents.json.gz"), { asBuffer: true });

    const stream = new Blob([contents]).stream();
    const decompressed_stream = stream.pipeThrough(new DecompressionStream("gzip"));
    let chunks = [];
    let counter = 0;
    for await (const chunk of decompressed_stream) {
        chunks.push(chunk);
        counter += chunk.length;
    }
    let decompressed_final = new Uint8Array(counter);
    counter = 0;
    for (const chunk of chunks) {
        decompressed_final.set(chunk, counter);
        counter += chunk.length;
    }

    let dec = new TextDecoder;
    let str = dec.decode(decompressed_final);
    let x = JSON.parse(str);
    return load_json_list(x, path, globals, options);
}

function dump_number_array(x) {
    let output = Array.from(x);
    for (var i = 0; i < output.length; i++) {
        let current = output[i];
        if (Number.isNaN(current)) {
            output[i] = "NaN";
        } else if (current == Number.POSITIVE_INFINITY) {
            output[i] = "Inf";
        } else if (current == Number.NEGATIVE_INFINITY) {
            output[i] = "-Inf";
        }
    }
    return output;
}

function dump_vector(x) {
    let vals = x.toArray();
    if (vals.length == 1 && "_jaspagate_scalar" in x && x._jaspagate_scalar) {
        return vals[0];
    } else {
        return vals;
    }
}

async function dump_json_list(x, path, globals, options, state) {
    if (x instanceof Array) {
        let output = { "type": "list", "values": [] };

        if (x.length) {
            let all_strings = true;
            let all_bools = true;
            let all_numbers = true;
            for (const e of x) {
                if (e !== null) {
                    if (typeof e !== "string") {
                        all_strings = false;
                    }
                    if (typeof e !== "boolean") {
                        all_bools = false;
                    }
                    if (typeof e !== "number") {
                        all_numbers = false;
                    }
                }
            }

            if (all_strings) {
                output.type = "string";
                output.values = x;
            } else if (all_bools) {
                output.type = "boolean";
                output.values = x;
            } else if (all_numbers) {
                output.type = "number";
                output.values = dump_number_array(x);
            } else {
                for (const e of x) {
                    output.values.push(await dump_json_list(e, path, globals, options, state));
                }
            }
        }

        return output;

    } else if (x instanceof List) {
        let output = { "type": "list", "values": [] }
        if (x instanceof IntegerList) {
            output.type = (exceedsInt32(x) ? "number" : "integer");
            output.values = dump_vector(x);
        } else if (x instanceof NumberList) {
            output.type = "number";
            output.values = dump_vector(x);
        } else if (x instanceof StringList) {
            output.type = "string";
            output.values = dump_vector(x);
        } else if (x instanceof BooleanList) {
            output.type = "boolean";
            output.values = dump_vector(x);
        } else {
            for (const v of x) {
                output.values.push(await dump_json_list(v, path, globals, options, state));
            }
        }
        if (x.names() !== null) {
            output.names = x.names();
        }
        return output;

    } else if (x === null) {
        return { "type": "nothing" };

    } else if (x.constructor === Object) {
        let output = { "type": "list", "values": [], "names": [] };
        for (const [k, v] of Object.entries(x)) {
            output.names.push(k);
            output.values.push(await dump_json_list(v, path, globals, options, state));
        }
        return output;

    } else if (x instanceof Int8Array || x instanceof Int16Array || x instanceof Int32Array || x instanceof Uint8Array || x instanceof Uint16Array) {
        return { "type": "integer", "values": Array.from(x) }

    } else if (x instanceof Uint32Array || x instanceof BigInt64Array || x instanceof BigUint64Array) {
        return { "type": "number", "values": Array.from(x).map(y => Number(y)) }

    } else if (x instanceof Float64Array || x instanceof Float32Array) {
        return { "type": "number", "values": dump_number_array(x) };

    } else if (typeof x == "number") {
        return { "type": "number", "values": x };

    } else if (typeof x == "string") {
        return { "type": "string", "values": x };

    } else if (typeof x == "boolean") {
        return { "type": "boolean", "values": x };

    } else {
        if ("List_saveOther" in options) {
            let converted = options.List_saveOther(x);
            if (converted !== null) {
                return converted;
            }
        }

        let odir = joinPath(path, "other_contents");
        if (!(await globals.exists(odir))) {
            await globals.mkdir(odir);
        }
        let curdex = state.index;
        await saveObject(x, joinPath(odir, String(curdex)), globals, options);
        state.index++;
        return { "type": "external", "index": curdex };
    }
}

/**
 * @param {external:List} x - The list.
 * @param {string} path - Path to the directory in which to save `x`.
 * @param {object} globals - Object satisfying the {@link GlobalsInterface}.
 * @param {object} [options={}] - Further options.
 * @param {function} [?options.List_saveOther=null] - Function to save custom class instances within a list, without resorting to a reference to an external object.
 * This should accept `y`, an instance of a custom object, and return an object containing the contents of `y` in the **uzuki2** JSON format.
 * If the class of `y` is not supported, `null` should be returned instead.
 *
 * @return `x` is stored at `path`.
 * @async
 */
export async function saveList(x, path, globals, options = {}) {
    await globals.mkdir(path);

    let objmeta = {
        type: "simple_list",
        simple_list: {
            version: "1.1",
            format: "json.gz"
        }
    };
    await globals.write(joinPath(path, "OBJECT"), JSON.stringify(objmeta));

    let converted = await dump_json_list(x, path, globals, options, { index: 0 });
    let stringified = JSON.stringify(converted);

    const stream = new Blob([stringified]).stream();
    const compressed_stream = stream.pipeThrough(new CompressionStream("gzip"));
    let chunks = [];
    let counter = 0;
    for await (const chunk of compressed_stream) {
        chunks.push(chunk);
        counter += chunk.length;
    }
    let compressed_final = new Uint8Array(counter);
    counter = 0;
    for (const chunk of chunks) {
        compressed_final.set(chunk, counter);
        counter += chunk.length;
    }

    await globals.write(joinPath(path, "list_contents.json.gz"), compressed_final);
}
