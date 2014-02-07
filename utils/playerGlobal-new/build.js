/* -*- Mode: js; js-indent-level: 2; indent-tabs-mode: nil; tab-width: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/*
 * Copyright 2014 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var fs = require('fs');
var spawn = require('child_process').spawn;

// simple args parsing
var rebuild = false;
var buildThreadsCount = 1;
var dependenciesRecursionLevel = 1;
var debugInfo = true;
var strict = true;
for (var i = 2; i < process.argv.length;) {
  var cmd = process.argv[i++];
  switch (cmd) {
    case '--threads':
    case '-t':
      buildThreadsCount = Math.max(1, process.argv[i++] | 0);
      break;
    case '--rebuild':
    case '-r':
      rebuild = true;
      break;
    default:
      throw new Error('Bad argument: ' + cmd);
  }
}


var build_dir = '../build/playerglobal';

var manifest = JSON.parse(fs.readFileSync('manifest.json'));
var manifestUpdated = fs.statSync('manifest.json').mtime.valueOf();
var jstemplate = '' + fs.readFileSync('playerglobal.js.template');
var ascjar = '../utils/asc.jar';
var buildasc = './avm2/generated/builtin/builtin.abc';

// switching working dir to ./src
process.chdir('../../src');

// prepare build folder
if (!fs.existsSync(build_dir)) {
  fs.mkdirSync(build_dir);
}
var dependencies = {files: {}, abcs: {}}, dependenciesUpdated = 0;
var dependenciesPath = build_dir + '/dependencies.json';
if (fs.existsSync(dependenciesPath) && !rebuild) {
  dependenciesUpdated = fs.statSync(dependenciesPath).mtime.valueOf();
  // discarding previous build if manifest was updated
  if (manifestUpdated <= dependenciesUpdated) {
    dependencies = JSON.parse(fs.readFileSync(dependenciesPath));
  } else {
    console.info('New manifest was found: refreshing builds');
  }
}

// reset file dependencies
Object.keys(dependencies.files).forEach(function (file) {
  var isNew = true;
  try {
    fileUpdated = fs.statSync(file).mtime.valueOf();
    isNew = fileUpdated > dependenciesUpdated;
  } catch(e) {}
  if (isNew) {
    dependencies.files[file].forEach(function (abc) {
      delete dependencies.abcs[abc];
    });
    delete dependencies.files[file];
  }
});

var buildQueue = [];
manifest.forEach(function (item) {
  var outputPath = build_dir + '/' + item.name + '.abc';
  item.outputPath = outputPath;
  // rebuilding if abc does not exist or removed from dependencies
  if (!fs.existsSync(outputPath) || !(item.name in dependencies.abcs)) {
    buildQueue.push(item);
  } else {
    item.dependencies = dependencies.abcs[item.name];
  }
});

function ensureDir(dir) {
  if (fs.existsSync(dir)) return;
  var parts = dir.split('/'), i = parts.length;
  while (!fs.existsSync(parts.slice(0, i - 1).join('/'))) {
    i--;
    if (i <= 0) throw new Error();
  }

  while (i <= parts.length) {
    fs.mkdirSync(parts.slice(0, i).join('/'));
    i++;
  }
}

function runAsc(threadId, outputPath, files, callback) {
  console.info('Building ' + outputPath + ' [' + threadId + '] ...');
  var outputDir = outputPath.substring(0, outputPath.lastIndexOf('/'));
  ensureDir(outputDir);
  var outputName = outputPath.substring(outputDir.length + 1);
  outputName = outputName.substring(0, outputName.lastIndexOf('.'));
  if (fs.existsSync(outputPath)) {
    fs.unlink(outputPath);
  }

  var args = ['-ea', '-DAS3', '-DAVMPLUS', '-classpath', ascjar,
              'macromedia.asc.embedding.ScriptCompiler', '-builtin'];
  if (debugInfo) {
    args.push('-d');
  }
  if (strict) {
    args.push('-strict');
  }
  args = args.concat(['-import', buildasc, '-outdir', outputDir,
                      '-out', outputName]).concat(files);
  var proc = spawn('java', args, {stdio: 'inherit'} );
  proc.on('close', function (code) {
    if (!fs.existsSync(outputPath)) {
      code = -1;
    }

    callback(code, outputPath);
  });
}

var ignoreDependenciesErrors = {
  'flash.utils.Dictionary': true,
  'flash.utils.ByteArray': true,
  'flash.utils.escapeMultiByte': true,
  'flash.utils.unescapeMultiByte': true,
  'flash.utils.IDataInput': true,
  // add more ..
};

function getDependencies(files) {
  var tmp = {}, tmpErr = {}, queue = [];
  files.forEach(function (file) {
    tmp[file] = true;
    queue.push(file);
  });
  while (queue.length > 0) {
    var file = queue.pop();
    try {
      var content = '' + fs.readFileSync(file);
      var m, re = /\bimport\s+(flash[\w\.]+)\s*;/g;
      while ((m = re.exec(content))) {
        var path = m[1].replace(/\./g, '/') + '.as';
        if (fs.existsSync(path)) {
          if (!tmp[path]) {
            tmp[path] = true;
            if (dependenciesRecursionLevel >= 2) {
              queue.push(path);
            }
          }
        } else if (!tmpErr[m[0]] && !ignoreDependenciesErrors[m[1]]) {
          console.log('Dependency file for \"' + m[0] + '\" was not found');
          tmpErr[m[0]] = true;
        }
      }
      m = /\bclass\s+\w+([^{]+)/.exec(content);
      if (m) {
        var baseClasses = m[1].replace(/\b(extends|implements)\b/g, '');
        re = /(\w+)/g;
        while ((m = re.exec(baseClasses))) {
          var path = file.substring(0, file.lastIndexOf('/') + 1) + m[1] + '.as';
          if (fs.existsSync(path)) {
            tmp[path] = true;
            if (dependenciesRecursionLevel >= 2) {
              queue.push(path);
            }
          }
        }
      }
    } catch (e) {
      console.log('Unable to get dependencies from ' + file + ': ' + e);
    }
  }
  return Object.keys(tmp);
}

var buildError = false, pending = 0;
function buildNext(threadId) {
  pending++;
  var item = buildQueue.shift();
  runAsc(threadId, item.outputPath, item.files, function (code, output) {
    if (buildError) {
      return; // ignoring parallel builds if error happend
    }
    if (code) {
      buildError = true;
      throw new Error('Build returned error code: ' + code);
    }

    item.dependencies = dependenciesRecursionLevel < 1 ? items.files :
      getDependencies(item.files);

    pending--;
    if (buildQueue.length === 0) {
      if (pending === 0) {
        completeBuild();
      }
      return;
    }

    buildNext(threadId);
  });
}

var updateDependencies = false;
if (buildQueue.length > 0) {
  updateDependencies = true;
  for (var i = 0; i < buildThreadsCount && buildQueue.length > 0; i++) {
    buildNext(i + 1);
  }
} else {
  completeBuild();
}

function updatePlayerglobal() {
  console.info('Updating playerglobal.js');

  var hex = '', lastPos = 0;
  manifest.forEach(function (item) {
    var file = item.outputPath;
    var ascData = fs.readFileSync(item.outputPath);
    delete item.outputPath;
    var ascHex = ascData.toString('hex');
    item.offset = lastPos;
    item.length = ascHex.length >> 1;
    lastPos += item.length;
    hex += ascHex;
  });
  fs.writeFileSync('flash/playerglobal-new.js',
    jstemplate.replace('[/*index*/]', JSON.stringify(manifest, null, 2)));
  fs.writeFileSync('flash/playerglobal-new.abc', new Buffer(hex, 'hex'));
}

function completeBuild() {
  var needsNewPlayerglobal = true;
  if (updateDependencies) {
    console.info('Updating dependencies');
    dependencies.files = {};
    dependencies.abcs = {};
    manifest.forEach(function (item) {
      var files = item.dependencies, name = item.name;
      files.forEach(function (file) {
        var abcs = dependencies.files[file];
        if (!abcs) {
          dependencies.files[file] = [name];
        } else {
          abcs.push(name);
        }
      });
      dependencies.abcs[name] = files;
      delete item.dependencies;
      delete item.files;
    });

    fs.writeFileSync(dependenciesPath, JSON.stringify(dependencies, null, 2));
  } else {
    console.info('Checking playerglobal.js');
    try {
      var playerglobalUpdated = fs.statSync('flash/playerglobal-new.js').mtime.valueOf();
      needsNewPlayerglobal = dependenciesUpdated > playerglobalUpdated;
    } catch (e) {}
  }

  if (needsNewPlayerglobal) {
    updatePlayerglobal();
  }
  console.log('Done.');
}
