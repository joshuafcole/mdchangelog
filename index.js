'use strict';

var exec = require('child_process').exec;
var async = require('async');
var path = require('path');
var Chaps = require('chaps');
var fs = require('fs');
var util = require('util');
var moment = require('moment-timezone');
var semver = require('semver');
var ejs = require('ejs');
var symbol = '⎆';
var validOrders = {
  issues: {
    number: true,
    opened_at: true,
    updated_at: true,
    closed_at: true
  },
  milestones: {
    number: true,
    opened_at: true,
    updated_at: true,
    title: true,
    semver: true
  }
};

function MDChangelog(opts) {
  var existingChangelog = '';
  var repo;
  var commits = [];
  var issues = {};
  var orphanIssues = [];
  var milestones = {};
  var contributors = {};
  var summary = {
    milestones: {
      open: 0,
      closed: 0
    },
    issues: {
      open: 0,
      closed: 0
    }
  };

  // opts.overwrite, opts.stdout implies opts.regenerate
  if (opts.overwrite || opts.stdout) {
    opts.regenerate = true;
  }

  if (opts.cwd) {
    opts.cwd = path.resolve(process.cwd(), opts.cwd);
  }
  opts.cwd = opts.cwd || process.cwd();

  // (optional) revision will be first passed value
  opts.revision = opts._[0];

  function parseExistingChangelog(cb) {
    if (opts.regenerate) {
      return cb(null);
    }
    var changelogPath = path.join(opts.cwd, 'CHANGELOG.md');
    if (fs.existsSync(changelogPath)) {
      existingChangelog = fs.readFileSync(changelogPath, 'utf8');
    }
    if (!opts.revision) {
      var regex = new RegExp('\\w+\\)' + symbol, 'g');
      var match = regex.exec(existingChangelog);
      if (match) {
        opts.anchor = match[0].substring(0, match[0].length - 2);
      }
      if (opts.anchor) {
        opts.revision = 'HEAD...' + opts.anchor;
      }
    }
    return cb(null);
  }

  function parseRepo(cb) {
    if (opts.remote) {
      repo = opts.remote;
      return cb();
    }
    var cmd = 'git config --get remote.origin.url';
    exec(cmd, {
      cwd: opts.cwd
    }, function(err, stdout, stderr) {
      if (err) {
        return cb(err + 'cannot find git remote');
      }
      if (stderr) {
        return cb(stderr + 'cannot find git remote');
      }
      var remote = stdout.match(/:[\S+]*.git/g);
      if (remote.length) {
        repo = remote[0].substring(1, (remote[0].length - 4));
      }
      if (!repo) {
        err = 'no remote';
      }
      cb(err);
    });
  }

  function parseGitLog(cb) {
    opts.revision = opts.revision || '';
    var delim = '----******----';
    var cmd = 'git log --pretty=format:"%H%n%h%n%ad%n%aN%n%s%n%B%n' + delim + '" --date=raw ' + opts.revision;
    var execOpts = {
      maxBuffer: 2000 * 1024,
      cwd: opts.cwd
    };
    exec(cmd, execOpts, function(err, stdout, stderr) {
      if (err) {
        return cb(err);
      }
      if (stderr) {
        return cb(stderr);
      }
      if (stdout === '') {
        return cb('no changes');
      }
      // anatomy of a git log entry
      var entrySignature = [
        'sha',
        'shaAbbr',
        'date',
        'author',
        'subject',
        'body'
      ];
      var entrySize = entrySignature.length - 1;

      // build the list of commits from the git log
      var commit = {};
      var sha;
      var line = 0;
      stdout.split('\n').forEach(function(entry) {
        if (entry === delim) {
          line = 0;
          // remove any trailing line return
          if (commit[sha].body[commit[sha].body.length - 1] === '') {
            commit[sha].body.pop();
          }
          // add commit to list of commits
          commits.push(commit[sha]);
          commit = {};
        } else {
          if (entrySignature[line] === 'sha') {
            sha = entry;
            commit[sha] = {};
          }
          if (line < entrySize) {
            if (entrySignature[line] === 'date') {
              var t = entry.split(' ');
              commit[sha][entrySignature[line]] = {
                timestamp: t[0],
                tz: t[1]
              };
            } else {
              if (entrySignature[line] === 'author') {
                contributors[entry] = contributors[entry] || true;
              }
              commit[sha][entrySignature[line]] = entry;
            }
          } else {
            commit[sha][entrySignature[entrySize]] = commit[sha][entrySignature[entrySize]] || [];
            commit[sha][entrySignature[entrySize]].push(entry);
          }
          line++;
        }
      });

      // parse each commit for signs of a reference to a github issue
      commits.forEach(function(commit) {
        var commitIssues = commit.body.join('\n').match(/[\w+\/\w+]*#[0-9]+/g);
        var issueData;
        commit.issues = [];
        if (commitIssues) {
          commitIssues.forEach(function(issue) {
            if (issue.indexOf('/') === -1) {
              issueData = {
                repo: repo,
                number: issue.substring(1)
              };
              commit.issues.push(issueData);
            } else {
              var split = issue.lastIndexOf('#');
              var issueRepo = issue.substring(0, split);
              var foreign = true;
              if (issueRepo === repo) {
                foreign = false;
              }
              issueData = {
                repo: issueRepo,
                number: issue.substring(split + 1),
                foreign: foreign
              };
              commit.issues.push(issueData);
            }
            var key = issueData.repo + '#' + issueData.number;
            issueData.key = key;
            issues[key] = issueData;
          });
        }
      });
      cb(null);
    });
  }

  function fetchIssues(cb) {
    var issuesList = [];
    for (var i in issues) {
      issuesList.push(issues[i]);
    }

    if (issuesList.length && !opts.stdout) {
      var ProgressBar = require('progress');
      var bar = new ProgressBar('fetching :current/:total issues [:bar] :percent :etas', {
        complete: '=',
        incomplete: ' ',
        width: 20,
        total: issuesList.length
      });
      process.stdout.write('fetching 0/' + issuesList.length + ' issues ');
    }
    var chaps = new Chaps({
      hostname: 'https://api.github.com',
      cache: false,
      timeout: opts.timeout || 10000,
      headers: {
        Authorization: 'token ' + process.env.MDCHANGELOG_TOKEN,
        'User-Agent': 'chalog'
      }
    });
    async.eachLimit(issuesList, 50, function(item, asyncCb) {
      chaps.get({
        url: '/repos/' + item.repo + '/issues/' + item.number
      }, function(err, res) {
        if (err || !res.body) {
          console.log('');
          return cb(err);
        }
        // message contains any error
        if (res.body.message) {
          if (res.body.message !== 'Not Found') {
            return asyncCb(res.body.message);
          }
        }
        // populate issue info
        if (res.body.title) {
          issues[item.key].title = res.body.title;
          issues[item.key].state = res.body.state;
          issues[item.key].created_at = res.body.created_at;
          issues[item.key].updated_at = res.body.updated_at;
          issues[item.key].closed_at = res.body.closed_at;
          summary.issues[issues[item.key].state]++;

          if (res.body.milestone) {
            milestones[res.body.milestone.number] = milestones[res.body.milestone.number] || {
              number: res.body.milestone.number,
              title: res.body.milestone.title,
              issues: {
                open: res.body.milestone.open_issues,
                closed: res.body.milestone.closed_issues
              },
              state: res.body.milestone.state,
              created_at: res.body.milestone.created_at,
              updated_at: res.body.milestone.updated_at,
              closed_at: res.body.milestone.closed_at
            };
            milestones[res.body.milestone.number].issues.list = milestones[res.body.milestone.number].issues.list || [];
            milestones[res.body.milestone.number].issues.list.push(issues[item.key]);
            summary.milestones[milestones[res.body.milestone.number].state]++;
            issues[item.key].milestone = milestones[res.body.milestone.number];
          } else {
            orphanIssues.push(issues[item.key]);
          }
        } else {
          // non-existent issue referenced in a commit
          // util.puts('no issue found:', item.key);
          delete issues[item.key];
        }
        if (bar) {
          bar.tick();
        }
        asyncCb();
      });
    }, function(err) {
      if (bar && !bar.complete) {
        // send a line end to terminal
        console.log('');
      }
      cb(err);
    });
  }

  function writeLog(cb) {
    var i;
    // build list of contributors
    var contributorsList = [];
    for (i in contributors) {
      contributorsList.push(i);
    }

    // build list of milestones
    var milestonesList = [];
    for (i in milestones) {
      milestones[i].issues.list.sort(function(a, b) {
        var val = [b, a];
        if (opts['reverse-issues']) {
          val = [a, b];
        }
        if (opts['order-issues'] === 'number') {
          return (val[0].number - val[1].number);
        }
        // multiple issues can be updated at the same time from one commit
        // so add the issue number to the sort value
        // Use number to catch nulls (such as ordering by closed_at when
        // the items is not actually closed)
        return ((Number(moment(val[0][opts['order-issues']]).format('X')) || 0) + val[0].number) - ((Number(moment(val[1][opts['order-issues']]).format('X')) || 0) + val[1].number);
      });
      milestonesList.push(milestones[i]);
    }

    milestonesList.sort(function(a, b) {
      var val = [b, a];
      if (opts['reverse-milestones']) {
        val = [a, b];
      }
      if (opts['order-milestones'] === 'number') {
        return (val[0].number - val[1].number);
      }
      if (opts['order-milestones'] === 'semver') {
        val.forEach(function(v){
          v.semver = v.title;
          if(!semver.valid(v.semver)) {
            v.semver = '0.0.0';
          }
        });
        return semver.gt(val[0].semver, val[1].semver);
      }

      if (opts['order-milestones'] === 'title') {
        return val[0].title.localeCompare(val[1].title);
      }
      // see milestone/issue ordering explanation
      return ((Number(moment(val[0][opts['order-milestones']]).format('X')) || 0) + val[0].number) - ((Number(moment(val[1][opts['order-milestones']]).format('X')) || 0) + val[1].number);
    });

    var startCommit = commits[0];
    var endCommit = commits[commits.length - 1];
    var startMoment = moment.unix(startCommit.date.timestamp).zone('UTC');
    var endMoment = moment.unix(endCommit.date.timestamp).zone('UTC');
    var duration = startMoment.from(endMoment, true);

    orphanIssues.sort(function(a, b) {
      var val = [b, a];
      if (opts.reverse) {
        val = [a, b];
      }
      if (opts['order-issues'] === 'number') {
        return (val[0].number - val[1].number);
      }
      // see milestone/issue ordering explanation
      return ((Number(moment(val[0][opts['order-issues']]).format('X')) || 0) + val[0].number) - ((Number(moment(val[1][opts['order-issues']]).format('X')) || 0) + val[1].number);
    });

    var data = {
      prologue: true,
      anchor: opts.anchor,
      repo: repo,
      symbol: symbol,
      issues: issues,
      orphanIssues: orphanIssues,
      milestonesList: milestonesList,
      summary: {
        commits: {
          start: {
            sha: startCommit.sha,
            shaAbbr: startCommit.shaAbbr,
            date: startMoment.format('YYYY-MM-DD')
          },
          end: {
            sha: endCommit.sha,
            shaAbbr: endCommit.shaAbbr,
            date: endMoment.format('YYYY-MM-DD')
          },
          total: commits.length,
          duration: duration,
          contributors: contributorsList
        },
        issues: {
          total: Object.keys(issues).length,
          open: summary.issues.open,
          closed: summary.issues.closed
        }
      }
    };

    if (opts['orphan-issues'] === false) {
      data.orphanIssues = [];
    }

    if (opts.prologue === false) {
      data.prologue = false;
    }

    if (milestonesList.length || orphanIssues.length) {
      var tpl = fs.readFileSync(path.join(__dirname, 'log.ejs'), 'utf8');
      var output = ejs.render(tpl, data) + existingChangelog;

      if (opts.stdout) {
        process.stdout.write(output);
      } else {
        fs.writeFileSync(path.join(opts.cwd, 'CHANGELOG.md'), output);
        util.puts('CHANGELOG.md written');
      }
      cb(null);
    } else {
      cb('no changes');
    }
  }

  return function generate(cb) {
    opts['order-issues'] = opts['order-issues'] || 'updated_at';
    opts['order-milestones'] = opts['order-milestones'] || 'updated_at';

    if (!validOrders.issues[opts['order-issues']]) {
      return cb('invalid order: "' + opts['order-issues'] + '", must be one of: ' + Object.keys(validOrders.issues));
    }
    if (!validOrders.milestones[opts['order-milestones']]) {
      return cb('invalid order: "' + opts['order-milestones'] + '", must be one of: ' + Object.keys(validOrders.milestones));
    }

    async.series([
      parseExistingChangelog,
      parseRepo,
      parseGitLog,
      fetchIssues
    ], function(err) {
      if (err) {
        cb(err);
      } else {
        writeLog(cb);
      }
    });
  };
}

module.exports = MDChangelog;
