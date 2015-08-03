
var express = require("express")
  , bodyParser = require("body-parser")
  , cookieParser = require("cookie-parser")
  , morgan = require("morgan")
  , exec = require('child_process').exec
  , http = require('http')
  , fs = require('fs')
  , request = require('request')
  , app = express()
  , port = Number(process.env.PORT || 5000);


app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // intercept OPTIONS method
  if ('OPTIONS' == req.method) {
    res.status(200).end();
  }
  else {
    next();
  }
});

app.use(express.static(__dirname + '/client'));
app.use(bodyParser.json());
app.use(cookieParser('I am a banana!'));

var download = function(url, dest, cb) {
  var file = fs.createWriteStream(dest);
  http.get(url,
  function _handleResponse(response) {
    response.pipe(file);
    file.on('finish', function() {
      file.close(cb);
    });
  });
};

app.storeFile = function(content, path, whendone) {
  fs.writeFile(path, content.split('\\n').join('\n').split('\\t').join('\t'),
  function _fileWritten() {
    whendone(null, {'path': path});
  });
};


// The magic sauce
app.fetchDomains = function(domainLoc, problemLoc, path, whendone) {
  var domainPath = path + '/domain.pddl';
  var problemPath = path + '/problem.pddl';
  download(domainLoc, domainPath,
  function _domDownloaded() {
    download(problemLoc, problemPath,
    function _probDownloaded() {
      whendone(null, {'domainPath': domainPath, 'problemPath': problemPath});
    });
  });
};

app.readDomains = function(domdata, probdata, path, whendone) {
  var domainPath = path + '/domain.pddl';
  var problemPath = path + '/problem.pddl';
  app.storeFile(domdata, domainPath,
  function _domStored(domErr, domRes) {
    if (domErr) {
      whendone(domErr, null);
    } else {
      app.storeFile(probdata, problemPath,
      function _probStored(probErr, probRes) {
        if (probErr) {
          whendone(probErr, null);
        } else {
          whendone(null, {'domainPath': domainPath, 'problemPath': problemPath});
        }
      });
    }
  });
}

app.fetchDomainsByID = function(problemID, path, whendone) {
  request({
    url: 'http://api.planning.domains/json/classical/problem/' + problemID,
    json: true
  },
  function _handleResponse(error, response, body) {
    if (error) {
      whendone(error, null);
    } else if (response.statusCode != 200) {
      whendone(body, null);
    } else {
      app.fetchDomains(body.result.domain_url, body.result.problem_url, path, whendone);
    }
  });
}

app.getDomains = function(problemID, problem, domain, is_url, path, whendone) {
  if (typeof problemID != 'undefined') {
    app.fetchDomainsByID(problemID, path, whendone);
  } else if ((typeof problem != 'undefined') && (typeof domain != 'undefined')) {
    if(typeof is_url === 'undefined' || is_url === false) {
      app.readDomains(domain, problem, path, whendone);
    } else {
      app.fetchDomains(domain, problem, path, whendone);
    }
  } else {
    whendone("Must define either domain and problem or probID.", null);
  }
}

app.solve = function(domainPath, problemPath, cwd, whendone) {
  var planPath = cwd + '/plan';
  var logPath = cwd + '/log';
  var addPathsAndRespond = function(error, result) {
    if (result) {
      result['planPath'] = planPath;
      result['logPath'] = logPath;
    }
    whendone(error, result);
  };
  exec(__dirname + '/plan ' + domainPath + ' ' + problemPath + ' ' + planPath
       + ' > ' + logPath + ' 2>&1; '
       + 'if [ -f ' + planPath + ' ]; then echo; echo Plan:; cat ' + planPath + '; fi',
       { timeout: 10000, cwd: cwd },
  function _processStopped(error, stdout, stderr) {
    if (error)
      whendone(error, null);
    else
      app.parsePlan(domainPath, problemPath, planPath, logPath, cwd, addPathsAndRespond);
  });
};

app.parsePlan = function(domainPath, problemPath, planPath, logPath, cwd, whendone) {
  exec('python ' + __dirname + '/process_solution.py '
       + domainPath + ' ' + problemPath + ' ' + planPath + ' ' + logPath,
       { timeout: 5000, cwd: cwd },
  function _processStopped(error, stdout, stderr) {
    if (error)
      whendone(error, null);
    else
      whendone(null, JSON.parse(stdout));
  });
};

app.validate = function(domainPath, problemPath, planPath, cwd, whendone) {
  exec(__dirname + '/validate -S ' + domainPath + ' ' + problemPath + ' ' + planPath,
    { timeout: 10000, cwd: cwd },
  function _processStopped(error, stdout, stderr) {
    if (error) {
      app.failValidate(domainPath, problemPath, planPath, cwd, whendone)
    } else if (stderr) {
      whendone("Validator wrote to stderr but did not report an error: " + stderr, null);
    } else if (isNaN(stdout.trim())) {
      whendone("Validator output does not look as expected. stdout: " + stdout, null)
    } else {
      var cost = parseInt(stdout.trim());
      whendone(null, {'result': 'valid', 'error': false, 'cost': cost});
    }
  });
};

app.failValidate = function(domainPath, problemPath, planPath, cwd, whendone) {
  exec(__dirname + '/validate -e ' + domainPath + ' ' + problemPath + ' ' + planPath,
    { timeout: 10000, cwd: cwd },
  function _processStopped(error, stdout, stderr) {
    whendone({
      'result': 'err',
      'error': 'Plan is invalid.',
      'val_stdout': stdout,
      'val_stderr': stderr
    }, null);
  });
}

app.errorToText = function(err) {
    return "Error :" + err;
}

app.resultToText = function(result) {
  var toRet = '';
  if (result['result'] === 'err') {
    toRet += "No plan found. Error:\n" + result['error'];
  } else {
    toRet += "Plan Found:\n  ";
    for (var i = 0; i < result['plan'].length; i++)
      toRet += "\n  " + result['plan'][i]['name'];
  }
  toRet += "\n\n\nOutput:\n";
  toRet += result['output'];
  return toRet;
}

app.set('view engine', 'ejs'); // set up ejs for templating

// set up our express application
app.use(morgan('dev')); // log every request to the console

// routes ======================================================================
require('./routes.js')(app); // load our routes and pass in our app

// launch ======================================================================
app.listen(port);
console.log('The magic happens on port ' + port);
