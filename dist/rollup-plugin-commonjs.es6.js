import { statSync } from 'fs';
import { extname, basename, sep, dirname, resolve } from 'path';
import { sync } from 'resolve';
import acorn from 'acorn';
import { walk } from 'estree-walker';
import MagicString from 'magic-string';
import { makeLegalIdentifier, attachScopes, createFilter } from 'rollup-pluginutils';

function isReference(node, parent) {
	if (parent.type === 'MemberExpression') return parent.computed || node === parent.object;

	// disregard the `bar` in { bar: foo }
	if (parent.type === 'Property' && node !== parent.value) return false;

	// disregard the `bar` in `class Foo { bar () {...} }`
	if (parent.type === 'MethodDefinition') return false;

	// disregard the `bar` in `export { foo as bar }`
	if (parent.type === 'ExportSpecifier' && node !== parent.local) return false;

	return true;
}

function flatten(node) {
	var name = void 0;
	var parts = [];

	while (node.type === 'MemberExpression') {
		if (node.computed) return null;

		parts.unshift(node.property.name);
		node = node.object;
	}

	if (node.type !== 'Identifier') return null;

	name = node.name;
	parts.unshift(name);

	return { name: name, keypath: parts.join('.') };
}

var firstpassGlobal = /\b(?:require|module|exports|global)\b/;
var firstpassNoGlobal = /\b(?:require|module|exports)\b/;
var exportsPattern = /^(?:module\.)?exports(?:\.([a-zA-Z_$][a-zA-Z_$0-9]*))?$/;

var reserved = 'abstract arguments boolean break byte case catch char class const continue debugger default delete do double else enum eval export extends false final finally float for function goto if implements import in instanceof int interface let long native new null package private protected public return short static super switch synchronized this throw throws transient true try typeof var void volatile while with yield'.split(' ');

var blacklistedExports = { __esModule: true };
reserved.forEach(function (word) {
	return blacklistedExports[word] = true;
});

function getName(id) {
	var base = basename(id);
	var ext = extname(base);

	return makeLegalIdentifier(ext.length ? base.slice(0, -ext.length) : base);
}

function getCandidatesForExtension(resolved, extension) {
	return [resolved + extension, resolved + (sep + 'index' + extension)];
}

function getCandidates(resolved, extensions) {
	return extensions.reduce(function (paths, extension) {
		return paths.concat(getCandidatesForExtension(resolved, extension));
	}, [resolved]);
}

function commonjs() {
	var options = arguments.length <= 0 || arguments[0] === undefined ? {} : arguments[0];

	var extensions = options.extensions || ['.js'];
	var filter = createFilter(options.include, options.exclude);
	var ignoreGlobal = options.ignoreGlobal;
	var firstpass = ignoreGlobal ? firstpassNoGlobal : firstpassGlobal;
	var bundleUsesGlobal = false;
	var bundleRequiresWrappers = false;

	var sourceMap = options.sourceMap !== false;

	var customNamedExports = {};
	if (options.namedExports) {
		Object.keys(options.namedExports).forEach(function (id) {
			var resolvedId = void 0;

			try {
				resolvedId = sync(id, { basedir: process.cwd() });
			} catch (err) {
				resolvedId = resolve(id);
			}

			customNamedExports[resolvedId] = options.namedExports[id];
		});
	}

	return {
		resolveId: function resolveId(importee, importer) {
			if (importee[0] !== '.' || !importer) return; // not our problem

			var resolved = resolve(dirname(importer), importee);
			var candidates = getCandidates(resolved, extensions);

			for (var i = 0; i < candidates.length; i += 1) {
				try {
					var stats = statSync(candidates[i]);
					if (stats.isFile()) return candidates[i];
				} catch (err) {/* noop */}
			}
		},
		transform: function transform(code, id) {
			if (!filter(id)) return null;
			if (extensions.indexOf(extname(id)) === -1) return null;
			if (!firstpass.test(code)) return null;

			var ast = void 0;

			try {
				ast = acorn.parse(code, {
					ecmaVersion: 6,
					sourceType: 'module'
				});
			} catch (err) {
				err.message += ' in ' + id;
				throw err;
			}

			var magicString = new MagicString(code);

			var required = {};
			var uid = 0;

			var scope = attachScopes(ast, 'scope');
			var uses = { module: false, exports: false, global: false };

			var namedExports = {};
			if (customNamedExports[id]) {
				customNamedExports[id].forEach(function (name) {
					return namedExports[name] = true;
				});
			}

			var scopeDepth = 0;

			walk(ast, {
				enter: function enter(node, parent) {
					if (node.scope) scope = node.scope;
					if (/^Function/.test(node.type)) scopeDepth += 1;

					if (sourceMap) {
						magicString.addSourcemapLocation(node.start);
						magicString.addSourcemapLocation(node.end);
					}

					// Is this an assignment to exports or module.exports?
					if (node.type === 'AssignmentExpression') {
						if (node.left.type !== 'MemberExpression') return;

						var flattened = flatten(node.left);
						if (!flattened) return;

						if (scope.contains(flattened.name)) return;

						var match = exportsPattern.exec(flattened.keypath);
						if (!match || flattened.keypath === 'exports') return;

						if (flattened.keypath === 'module.exports' && node.right.type === 'ObjectExpression') {
							return node.right.properties.forEach(function (prop) {
								if (prop.computed || prop.key.type !== 'Identifier') return;
								var name = prop.key.name;
								if (name === makeLegalIdentifier(name)) namedExports[name] = true;
							});
						}

						if (match[1]) namedExports[match[1]] = true;

						return;
					}

					if (node.type === 'Identifier') {
						if (node.name in uses && !uses[node.name] && isReference(node, parent) && !scope.contains(node.name)) uses[node.name] = true;
						return;
					}

					if (node.type === 'ThisExpression' && scopeDepth === 0 && !ignoreGlobal) {
						uses.global = true;
						magicString.overwrite(node.start, node.end, '__commonjs_global', true);
						return;
					}

					if (node.type !== 'CallExpression') return;
					if (node.callee.name !== 'require' || scope.contains('require')) return;
					if (node.arguments.length !== 1 || node.arguments[0].type !== 'Literal') return; // TODO handle these weird cases?

					var source = node.arguments[0].value;

					var existing = required[source];
					var name = void 0;

					if (!existing) {
						name = 'require$$' + uid++;
						required[source] = { source: source, name: name, importsDefault: false };
					} else {
						name = required[source].name;
					}

					if (parent.type !== 'ExpressionStatement') {
						required[source].importsDefault = true;
						magicString.overwrite(node.start, node.end, name);
					} else {
						// is a bare import, e.g. `require('foo');`
						magicString.remove(parent.start, parent.end);
					}
				},
				leave: function leave(node) {
					if (node.scope) scope = scope.parent;
					if (/^Function/.test(node.type)) scopeDepth -= 1;
				}
			});

			var sources = Object.keys(required);

			if (!sources.length && !uses.module && !uses.exports && !uses.global) {
				if (Object.keys(namedExports).length) {
					throw new Error('Custom named exports were specified for ' + id + ' but it does not appear to be a CommonJS module');
				}
				return null; // not a CommonJS module
			}

			bundleRequiresWrappers = true;

			var name = getName(id);

			var importBlock = sources.length ? sources.map(function (source) {
				var _required$source = required[source];
				var name = _required$source.name;
				var importsDefault = _required$source.importsDefault;

				return 'import ' + (importsDefault ? name + ' from ' : '') + '\'' + source + '\';';
			}).join('\n') : '';

			var args = 'module' + (uses.exports || uses.global ? ', exports' : '') + (uses.global ? ', global' : '');

			var intro = '\n\nvar ' + name + ' = __commonjs(function (' + args + ') {\n';
			var outro = '\n});\n\nexport default (' + name + ' && typeof ' + name + ' === \'object\' && \'default\' in ' + name + ' ? ' + name + '[\'default\'] : ' + name + ');\n';

			outro += Object.keys(namedExports).filter(function (key) {
				return !blacklistedExports[key];
			}).map(function (x) {
				return 'export var ' + x + ' = ' + name + '.' + x + ';';
			}).join('\n');

			magicString.trim().prepend(importBlock + intro).trim().append(outro);

			code = magicString.toString();
			var map = sourceMap ? magicString.generateMap() : null;

			if (uses.global) bundleUsesGlobal = true;

			return { code: code, map: map };
		},
		intro: function intro() {
			var intros = [];

			if (bundleUsesGlobal) {
				intros.push('var __commonjs_global = typeof window !== \'undefined\' ? window : typeof global !== \'undefined\' ? global : typeof self !== \'undefined\' ? self : {}');
			}

			if (bundleRequiresWrappers) {
				intros.push('function __commonjs(fn, module) { return module = { exports: {} }, fn(module, module.exports' + (bundleUsesGlobal ? ', __commonjs_global' : '') + '), module.exports; }\n');
			}

			return intros.join('\n');
		}
	};
}

export default commonjs;