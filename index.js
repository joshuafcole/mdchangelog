'use strict';

var exec = require('child_process').exec;
var async = require('async');
var path = require('path');
var Chaps = require('chaps');
var fs = require('fs');
var moment = require('moment-timezone');
var ejs = require('ejs');
var symbol = '⎆';

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

  // (optional) revision will be first passed value
  opts.revision = opts._[0];

  function parseExistingChangelog(cb) {
    if (opts.overwrite) {
      return cb(null);
    }
    var changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
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
    var cmd = 'git config --get remote.origin.url';
    exec(cmd, function(err, stdout, stderr) {
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
      cwd: process.cwd()
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

    if (issuesList.length) {
      var ProgressBar = require('progress');
      var bar = new ProgressBar('fetching issues [:bar] :percent :etas', {
        complete: '=',
        incomplete: ' ',
        width: 20,
        total: issuesList.length
      });
      process.stdout.write('fetching issues ');
    }
    var chaps = new Chaps({
      hostname: 'https://api.github.com',
      cache: false,
      timeout: opts.timeout || 2000,
      headers: {
        Authorization: 'token ' + process.env.MDCHANGELOG_TOKEN,
        'User-Agent': 'chalog'
      }
    });
    async.eachLimit(issuesList, 25, function(item, asyncCb) {
      chaps.get({
        url: '/repos/' + item.repo + '/issues/' + item.number
      }, function(err, res) {
        if (err || !res.body) {
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
          issues[item.key].updated_at = res.body.updated_at;
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
              created_at: res.body.milestone.created_at
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
        bar.tick();
        asyncCb();
      });
    }, function(err) {
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
        // multiple issues can be updated at the same time from one commit
        // so add the issue number to the sort value
        return (moment(b.updated_at).format('X') + b.number) - (moment(a.updated_at).format('X') + a.number);
      });
      milestonesList.push(milestones[i]);
    }
    milestonesList.sort(function(a, b) {
      return moment(b.created_at).format('X') - moment(a.created_at).format('X');
    });

    var startCommit = commits[0];
    var endCommit = commits[commits.length - 1];
    var startMoment = moment.unix(startCommit.date.timestamp).zone('UTC');
    var endMoment = moment.unix(endCommit.date.timestamp).zone('UTC');
    var duration = startMoment.from(endMoment, true);

    orphanIssues.sort(function(a, b) {
      // multiple issues can be updated at the same time from one commit
      // so add the issue number to the sort value
      return (moment(b.updated_at).format('X') + b.number) - (moment(a.updated_at).format('X') + a.number);
    });

    var data = {
      prologue: true,
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
      cb(null, ejs.render(tpl, data) + existingChangelog);
    } else {
      cb('no changes');
    }
  }

  return function generate(cb) {
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
