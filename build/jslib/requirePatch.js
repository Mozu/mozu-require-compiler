/**
 * @license RequireJS Copyright (c) 2010-2014, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */
/*
 * This file patches require.js to communicate with the build system.
 */

//Using sloppy since this uses eval for some code like plugins,
//which may not be strict mode compliant. So if use strict is used
//below they will have strict rules applied and may cause an error.
/*jslint sloppy: true, nomen: true, plusplus: true, regexp: true */
/*global require, define: true */

//NOT asking for require as a dependency since the goal is to modify the
//global require below
define([ 'env!env/file', 'pragma', 'parse', 'lang', 'logger', 'commonJs', 'prim'], function (
    file,
    pragma,
    parse,
    lang,
    logger,
    commonJs,
    prim
) {

    var allowRun = true,
        hasProp = lang.hasProp,
        falseProp = lang.falseProp,
        getOwn = lang.getOwn;

    //This method should be called when the patches to require should take hold.
    return function () {
        if (!allowRun) {
            return;
        }
        allowRun = false;

        var layer,
            pluginBuilderRegExp = /(["']?)pluginBuilder(["']?)\s*[=\:]\s*["']([^'"\s]+)["']/,
            oldNewContext = require.s.newContext,
            oldDef,

            //create local undefined values for module and exports,
            //so that when files are evaled in this function they do not
            //see the node values used for r.js
            exports,
            module;

        /**
         * Reset "global" build caches that are kept around between
         * build layer builds. Useful to do when there are multiple
         * top level requirejs.optimize() calls.
         */
        require._cacheReset = function () {
            //Stored raw text caches, used by browser use.
            require._cachedRawText = {};
            //Stored cached file contents for reuse in other layers.
            require._cachedFileContents = {};
            //Store which cached files contain a require definition.
            require._cachedDefinesRequireUrls = {};
        };
        require._cacheReset();

        /**
         * Makes sure the URL is something that can be supported by the
         * optimization tool.
         * @param {String} url
         * @returns {Boolean}
         */
        require._isSupportedBuildUrl = function (url) {
            //Ignore URLs with protocols, hosts or question marks, means either network
            //access is needed to fetch it or it is too dynamic. Note that
            //on Windows, full paths are used for some urls, which include
            //the drive, like c:/something, so need to test for something other
            //than just a colon.
            if (url.indexOf("://") === -1 && url.indexOf("?") === -1 &&
                    url.indexOf('empty:') !== 0 && url.indexOf('//') !== 0) {
                return true;
            } else {
                if (!layer.ignoredUrls[url]) {
                    if (url.indexOf('empty:') === -1) {
                        logger.info('Cannot optimize network URL, skipping: ' + url);
                    }
                    layer.ignoredUrls[url] = true;
                }
                return false;
            }
        };

        function normalizeUrlWithBase(context, moduleName, url) {
            //Adjust the URL if it was not transformed to use baseUrl.
            if (require.jsExtRegExp.test(moduleName)) {
                url = (context.config.dir || context.config.dirBaseUrl) + url;
            }
            return url;
        }

        //Overrides the new context call to add existing tracking features.
        require.s.newContext = function (name) {

            
            /** @license
             * Shims non-AMD scripts with a define call. Based on depend.js require plugin by Miller Medeiros.
             * Author: James Zetlen, Volusion
             * Version: 0.1.0 (2012/11/29)
             * Released under the MIT license
             */
            // define the builtin shim plugin super hardcore maybe?
            define('shim',['module'], function (module) {

                var unableToParse = 'Unable to parse shim dependency.',
                    buildMap = {},
                    nameRE = /[^\[>]+/,
                    depNameRE = /(.+)=([a-zA-Z_$][0-9a-zA-Z_$]*)$/,
                    exportRE = />([^\]]+)$/,
                    parseName = function (name) {
                        var index = name.indexOf("."),
                            modName = name.substring(0, index),
                            ext = name.substring(index + 1, name.length);

                        return {
                            moduleName: modName,
                            ext: ext
                        };
                    },

                // because you can have arbitrarily nested shims, a JS regex cannot parse the whole thing, so we have to use string methods.
                    parseDeps = function (name) {
                        var firstBr = name.indexOf('['),
                            lastBr = name.lastIndexOf(']'),
                            parsedName = nameRE.exec(name),
                            parsedExport = exportRE.exec(name),
                            deps,
                            namedDeps = [],
                            anonDeps = [],
                            args = [];

                        if (!parsedName) throw unableToParse;

                        var modName = parsedName[0],
                            toExport = parsedExport ? parsedExport[1] : null;

                        if (firstBr !== -1 && lastBr !== -1) {
                            var depsString = name.substring(firstBr + 1, lastBr),
                                depName,
                                depMatch,
                                nestingLevel = 0,
                                lastCommaIndex = -1,
                                isComma = false,
                                char;
                            for (var i = 0; i < depsString.length; i++) {
                                char = depsString.charAt(i);
                                if (char === "[") nestingLevel++;
                                if (char === "]") nestingLevel--;
                                isComma = char === (',');
                                if (nestingLevel < 0) throw unableToParse;
                                if ((isComma || i + 1 === depsString.length) && nestingLevel === 0) {
                                    depName = depsString.substring(lastCommaIndex + 1, isComma ? i : i + 1);
                                    depMatch = depNameRE.exec(depName);
                                    if (depMatch) {
                                        namedDeps.push(depMatch[1]);
                                        args.push(depMatch[2]);
                                    } else {
                                        anonDeps.push(depName);
                                    }
                                    lastCommaIndex = i;
                                }
                            }

                        }

                        return { name: modName, deps: namedDeps.concat(anonDeps), args: args, toExport: toExport };

                    },

                    namedTmpl = 'define(\'{4}\',[{0}], function({1}) { \n\n{2} ; \n\nreturn {3}; \n\n});\n\n\n//@ sourceURL=/{4}.js\n\n',
                    anonTmpl = namedTmpl.replace('\'{4}\',', ''),
                    createTextModule = function (parsedConf, body, named) {
                        var stringDeps = parsedConf.deps.length > 0 ? "'" + parsedConf.deps.join("','") + "'" : '';
                        return (named ? namedTmpl : anonTmpl)
                                .split('{0}').join(stringDeps)
                                .split('{1}').join(parsedConf.args.join(","))
                                .split('{3}').join(parsedConf.toExport)
                                .split('{4}').join(parsedConf.name)
                                .split('{2}').join(body);
                    },

                    fs = require.nodeRequire('fs'),

                    getText = function (url, callback) {
                        var file = fs.readFileSync(url, 'utf8');
                        //Remove BOM (Byte Mark Order) from utf8 files if it is there.
                        if (file.indexOf('\uFEFF') === 0) {
                            file = file.substring(1);
                        }
                        callback(file);
                    },

                    masterConfig = (module.config && module.config()) || {},

                    finishLoad = function (name, content, onLoad) {
                        if (masterConfig.isBuild) {
                            buildMap[name] = content;
                        }
                        onLoad(content);
                    };

                return {

                    write: function (pluginName, moduleName, write, config) {
                        var parsedConf = parseDeps(moduleName);
                        if (buildMap.hasOwnProperty(parsedConf.name)) {
                            write.asModule(pluginName + '!' + moduleName, createTextModule(parsedConf, buildMap[parsedConf.name]));
                        } else {
                            getText(require.toUrl(parsedConf.name), function (txt) {
                                buildMap[parsedConf.name] = txt;
                                write.asModule(pluginName + '!' + moduleName, createTextModule(parsedConf, txt));
                            });
                        }
                    },

                    // example: shim!vendor/jquery.ui.plugin[jquery=jQuery,jqueryui]
                    // to export: shim!vendor/backbone[shim!underscore>_]>Backbone
                    load: function (name, req, onLoad, config) {
                        //Name has format: some.module.filext!strip
                        //The strip part is optional.
                        //if strip is present, then that means only get the string contents
                        //inside a body tag in an HTML string. For XML/SVG content it means
                        //removing the <?xml ...?> declarations so the content can be inserted
                        //into the current doc without problems.

                        var parsedConf = parseDeps(name),
                        oldOnLoad = onLoad;

                        onLoad = function(txt) {
                            if (config.isBuild) buildMap[parsedConf.name] = txt;
                            eval(createTextModule(parsedConf, txt, true));
                            req([parsedConf.name], oldOnLoad);
                        };

                        onLoad.error = function() {
                            oldOnLoad.error.apply(oldOnLoad, arguments);
                        };

                        name = parsedConf.name + ".js";

                        masterConfig.isBuild = config.isBuild;

                        var parsed = parseName(name),
                            nonStripName = parsed.moduleName + '.' + parsed.ext,
                            url = req.toUrl(nonStripName);

                        //Load the text. Use XHR if possible and in a browser.

                        getText(url, function (content) {
                                finishLoad(name, content, onLoad);
                        }, function (err) {
                            if (onLoad.error) {
                                onLoad.error(err);
                            }
                        });
                        
                    },

                };

            });
            var context = oldNewContext(name),
                oldEnable = context.enable,
                moduleProto = context.Module.prototype,
                oldInit = moduleProto.init,
                oldCallPlugin = moduleProto.callPlugin;

            //Only do this for the context used for building.
            if (name === '_') {
                //For build contexts, do everything sync
                context.nextTick = function (fn) {
                    fn();
                };

                context.needFullExec = {};
                context.fullExec = {};
                context.plugins = {};
                context.buildShimExports = {};

                //Override the shim exports function generator to just
                //spit out strings that can be used in the stringified
                //build output.
                context.makeShimExports = function (value) {
                    function fn() {
                        return '(function (global) {\n' +
                            '    return function () {\n' +
                            '        var ret, fn;\n' +
                            (value.init ?
                                    ('       fn = ' + value.init.toString() + ';\n' +
                                    '        ret = fn.apply(global, arguments);\n') : '') +
                            (value.exports ?
                                    '        return ret || global.' + value.exports + ';\n' :
                                    '        return ret;\n') +
                            '    };\n' +
                            '}(this))';
                    }

                    return fn;
                };

                context.enable = function (depMap, parent) {
                    var id = depMap.id,
                        parentId = parent && parent.map.id,
                        needFullExec = context.needFullExec,
                        fullExec = context.fullExec,
                        mod = getOwn(context.registry, id);

                    if (mod && !mod.defined) {
                        if (parentId && getOwn(needFullExec, parentId)) {
                            needFullExec[id] = true;
                        }

                    } else if ((getOwn(needFullExec, id) && falseProp(fullExec, id)) ||
                               (parentId && getOwn(needFullExec, parentId) &&
                                falseProp(fullExec, id))) {
                        context.require.undef(id);
                    }

                    return oldEnable.apply(context, arguments);
                };

                //Override load so that the file paths can be collected.
                context.load = function (moduleName, url) {
                    /*jslint evil: true */
                    var contents, pluginBuilderMatch, builderName,
                        shim, shimExports;

                    //Do not mark the url as fetched if it is
                    //not an empty: URL, used by the optimizer.
                    //In that case we need to be sure to call
                    //load() for each module that is mapped to
                    //empty: so that dependencies are satisfied
                    //correctly.
                    if (url.indexOf('empty:') === 0) {
                        delete context.urlFetched[url];
                    }

                    //Only handle urls that can be inlined, so that means avoiding some
                    //URLs like ones that require network access or may be too dynamic,
                    //like JSONP
                    if (require._isSupportedBuildUrl(url)) {
                        //Adjust the URL if it was not transformed to use baseUrl.
                        url = normalizeUrlWithBase(context, moduleName, url);

                        //Save the module name to path  and path to module name mappings.
                        layer.buildPathMap[moduleName] = url;
                        layer.buildFileToModule[url] = moduleName;

                        if (hasProp(context.plugins, moduleName)) {
                            //plugins need to have their source evaled as-is.
                            context.needFullExec[moduleName] = true;
                        }

                        prim().start(function () {
                            if (hasProp(require._cachedFileContents, url) &&
                                    (falseProp(context.needFullExec, moduleName) ||
                                    getOwn(context.fullExec, moduleName))) {
                                contents = require._cachedFileContents[url];

                                //If it defines require, mark it so it can be hoisted.
                                //Done here and in the else below, before the
                                //else block removes code from the contents.
                                //Related to #263
                                if (!layer.existingRequireUrl && require._cachedDefinesRequireUrls[url]) {
                                    layer.existingRequireUrl = url;
                                }
                            } else {
                                //Load the file contents, process for conditionals, then
                                //evaluate it.
                                return require._cacheReadAsync(url).then(function (text) {
                                    contents = text;

                                    if (context.config.cjsTranslate &&
                                        (!context.config.shim || !lang.hasProp(context.config.shim, moduleName))) {
                                        contents = commonJs.convert(url, contents);
                                    }

                                    //If there is a read filter, run it now.
                                    if (context.config.onBuildRead) {
                                        contents = context.config.onBuildRead(moduleName, url, contents);
                                    }

                                    contents = pragma.process(url, contents, context.config, 'OnExecute');

                                    //Find out if the file contains a require() definition. Need to know
                                    //this so we can inject plugins right after it, but before they are needed,
                                    //and to make sure this file is first, so that define calls work.
                                    try {
                                        if (!layer.existingRequireUrl && parse.definesRequire(url, contents)) {
                                            layer.existingRequireUrl = url;
                                            require._cachedDefinesRequireUrls[url] = true;
                                        }
                                    } catch (e1) {
                                        throw new Error('Parse error using esprima ' +
                                                        'for file: ' + url + '\n' + e1);
                                    }
                                }).then(function () {
                                    if (hasProp(context.plugins, moduleName)) {
                                        //This is a loader plugin, check to see if it has a build extension,
                                        //otherwise the plugin will act as the plugin builder too.
                                        pluginBuilderMatch = pluginBuilderRegExp.exec(contents);
                                        if (pluginBuilderMatch) {
                                            //Load the plugin builder for the plugin contents.
                                            builderName = context.makeModuleMap(pluginBuilderMatch[3],
                                                                                context.makeModuleMap(moduleName),
                                                                                null,
                                                                                true).id;
                                            return require._cacheReadAsync(context.nameToUrl(builderName));
                                        }
                                    }
                                    return contents;
                                }).then(function (text) {
                                    contents = text;

                                    //Parse out the require and define calls.
                                    //Do this even for plugins in case they have their own
                                    //dependencies that may be separate to how the pluginBuilder works.
                                    try {
                                        if (falseProp(context.needFullExec, moduleName)) {
                                            contents = parse(moduleName, url, contents, {
                                                insertNeedsDefine: true,
                                                has: context.config.has,
                                                findNestedDependencies: context.config.findNestedDependencies
                                            });
                                        }
                                    } catch (e2) {
                                        throw new Error('Parse error using esprima ' +
                                                        'for file: ' + url + '\n' + e2);
                                    }

                                    require._cachedFileContents[url] = contents;
                                });
                            }
                        }).then(function () {
                            if (contents) {
                                eval(contents);
                            }

                            try {
                                //If have a string shim config, and this is
                                //a fully executed module, try to see if
                                //it created a variable in this eval scope
                                if (getOwn(context.needFullExec, moduleName)) {
                                    shim = getOwn(context.config.shim, moduleName);
                                    if (shim && shim.exports) {
                                        shimExports = eval(shim.exports);
                                        if (typeof shimExports !== 'undefined') {
                                            context.buildShimExports[moduleName] = shimExports;
                                        }
                                    }
                                }

                                //Need to close out completion of this module
                                //so that listeners will get notified that it is available.
                                context.completeLoad(moduleName);
                            } catch (e) {
                                //Track which module could not complete loading.
                                if (!e.moduleTree) {
                                    e.moduleTree = [];
                                }
                                e.moduleTree.push(moduleName);
                                throw e;
                            }
                        }).then(null, function (eOuter) {

                            if (!eOuter.fileName) {
                                eOuter.fileName = url;
                            }
                            throw eOuter;
                        }).end();
                    } else {
                        //With unsupported URLs still need to call completeLoad to
                        //finish loading.
                        context.completeLoad(moduleName);
                    }
                };

                //Marks module has having a name, and optionally executes the
                //callback, but only if it meets certain criteria.
                context.execCb = function (name, cb, args, exports) {
                    var buildShimExports = getOwn(layer.context.buildShimExports, name);

                    if (buildShimExports) {
                        return buildShimExports;
                    } else if (cb.__requireJsBuild || getOwn(layer.context.needFullExec, name)) {
                        return cb.apply(exports, args);
                    }
                    return undefined;
                };

                moduleProto.init = function (depMaps) {
                    if (context.needFullExec[this.map.id]) {
                        lang.each(depMaps, lang.bind(this, function (depMap) {
                            if (typeof depMap === 'string') {
                                depMap = context.makeModuleMap(depMap,
                                               (this.map.isDefine ? this.map : this.map.parentMap));
                            }

                            if (!context.fullExec[depMap.id]) {
                                context.require.undef(depMap.id);
                            }
                        }));
                    }

                    return oldInit.apply(this, arguments);
                };

                moduleProto.callPlugin = function () {
                    var map = this.map,
                        pluginMap = context.makeModuleMap(map.prefix),
                        pluginId = pluginMap.id,
                        pluginMod = getOwn(context.registry, pluginId);

                    context.plugins[pluginId] = true;
                    context.needFullExec[pluginId] = true;

                    //If the module is not waiting to finish being defined,
                    //undef it and start over, to get full execution.
                    if (falseProp(context.fullExec, pluginId) && (!pluginMod || pluginMod.defined)) {
                        context.require.undef(pluginMap.id);
                    }

                    return oldCallPlugin.apply(this, arguments);
                };
            }

            return context;
        };

        //Clear up the existing context so that the newContext modifications
        //above will be active.
        delete require.s.contexts._;

        /** Reset state for each build layer pass. */
        require._buildReset = function () {
            var oldContext = require.s.contexts._;

            //Clear up the existing context.
            delete require.s.contexts._;

            //Set up new context, so the layer object can hold onto it.
            require({});

            layer = require._layer = {
                buildPathMap: {},
                buildFileToModule: {},
                buildFilePaths: [],
                pathAdded: {},
                modulesWithNames: {},
                needsDefine: {},
                existingRequireUrl: "",
                ignoredUrls: {},
                context: require.s.contexts._
            };

            //Return the previous context in case it is needed, like for
            //the basic config object.
            return oldContext;
        };

        require._buildReset();

        //Override define() to catch modules that just define an object, so that
        //a dummy define call is not put in the build file for them. They do
        //not end up getting defined via context.execCb, so we need to catch them
        //at the define call.
        oldDef = define;

        //This function signature does not have to be exact, just match what we
        //are looking for.
        define = function (name) {
            if (typeof name === "string" && falseProp(layer.needsDefine, name)) {
                layer.modulesWithNames[name] = true;
            }
            return oldDef.apply(require, arguments);
        };

        define.amd = oldDef.amd;

        //Add some utilities for plugins
        require._readFile = file.readFile;
        require._fileExists = function (path) {
            return file.exists(path);
        };

        //Called when execManager runs for a dependency. Used to figure out
        //what order of execution.
        require.onResourceLoad = function (context, map) {
            var id = map.id,
                url;

            //If build needed a full execution, indicate it
            //has been done now. But only do it if the context is tracking
            //that. Only valid for the context used in a build, not for
            //other contexts being run, like for useLib, plain requirejs
            //use in node/rhino.
            if (context.needFullExec && getOwn(context.needFullExec, id)) {
                context.fullExec[id] = true;
            }

            //A plugin.
            if (map.prefix) {
                if (falseProp(layer.pathAdded, id)) {
                    layer.buildFilePaths.push(id);
                    //For plugins the real path is not knowable, use the name
                    //for both module to file and file to module mappings.
                    layer.buildPathMap[id] = id;
                    layer.buildFileToModule[id] = id;
                    layer.modulesWithNames[id] = true;
                    layer.pathAdded[id] = true;
                }
            } else if (map.url && require._isSupportedBuildUrl(map.url)) {
                //If the url has not been added to the layer yet, and it
                //is from an actual file that was loaded, add it now.
                url = normalizeUrlWithBase(context, id, map.url);
                if (!layer.pathAdded[url] && getOwn(layer.buildPathMap, id)) {
                    //Remember the list of dependencies for this layer.
                    layer.buildFilePaths.push(url);
                    layer.pathAdded[url] = true;
                }
            }
        };

        //Called by output of the parse() function, when a file does not
        //explicitly call define, probably just require, but the parse()
        //function normalizes on define() for dependency mapping and file
        //ordering works correctly.
        require.needsDefine = function (moduleName) {
            layer.needsDefine[moduleName] = true;
        };
    };
});
