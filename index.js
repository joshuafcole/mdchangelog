'use strict';

var util = require('util');
var exec = require('child_process').exec, child;
var async = require('async');
var Chaps = require('chaps');
var chaps = new Chaps({
  hostname: 'https://api.github.com',
  cache: false,
  headers: {
    Authorization: 'token ' + process.env.MDCHANGELOG_TOKEN,
    'User-Agent': 'chalog'
  }
});
var moment = require('moment-timezone');

module.exports = function(){
  var repo;
  var issues = {};
  var contributors = {};
  var milestones = {};
  var milestonesSummary = {
    open: 0,
    closed: 0
  };
  var issuesSummary = {
    open: 0,
    closed: 0
  };
  var commits = [];
  var range;

  function setRange(revisionSelection){
    range = revisionSelection || '';
  }

  function parseRepo(cb){
    var cmd = 'git config --get remote.origin.url';
    child = exec(cmd, function (err, stdout, stderr) {
      if(err) {
        return cb(err + 'cannot find git remote');
      }
      if(stderr) {
        return cb(stderr + 'cannot find git remote');
      }
      var remote = stdout.match(/:[\S+]*.git/g);
      if(remote.length){
        repo = remote[0].substring(1, (remote[0].length-4));
      }
      if(repo){
        return cb(null, repo);
      }
      cb('no remote');
    });
  }

  function parseGitLog(cb) {
    var delim = '----******----';
    var cmd = 'git log --pretty=format:"%H%n%h%n%ad%n%aN%n%s%n%B%n' + delim + '" --date=raw ' + range;
    var execOpts = {
      maxBuffer: 2000*1024,
      cwd: process.cwd()
    };
    child = exec(cmd, execOpts, function (err, stdout, stderr) {
      if(err) {
        return cb(err);
      }
      if(stderr) {
        return cb(stderr);
      }
      var line = 0;
      var entrySignature = [
        'sha',
        'shaAbbr',
        'date',
        'author',
        'subject',
        'body'
      ];
      var entrySize = entrySignature.length -1;
      var sha;
      var commit = {};
      stdout.split('\n').forEach(function(entry){
        if(entry === delim){
          line = 0;
          // remove any trailing line return
          if(commit[sha].body[commit[sha].body.length -1] === ''){
            commit[sha].body.pop();
          }
          commits.push(commit[sha]);
          commit = {};
        } else {
          if(entrySignature[line] === 'sha'){
            sha = entry;
            commit[sha] = {};
          }
          if(line < entrySize) {
            if(entrySignature[line] === 'date'){
              var t = entry.split(' ');
              commit[sha][entrySignature[line]] = {
                timestamp: t[0],
                tz: t[1]
              };
            } else {
              if(entrySignature[line] === 'author'){
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

      commits.forEach(function(commit){
        var commitIssues = commit.body.join('\n').match(/[\w+\/\w+]*#[0-9]+/g);
        var issueData;
        commit.issues = [];
        if(commitIssues) {
          commitIssues.forEach(function(issue){
            if(issue.indexOf('/') === -1){
              issueData = {
                repo: repo,
                number: issue.substring(1)
              };
              commit.issues.push(issueData);
            } else {
              var split = issue.lastIndexOf('#');
              var issueRepo = issue.substring(0, split);
              var foreign = true;
              if(issueRepo === repo){
                foreign = false;
              }
              issueData = {
                repo: issueRepo,
                number: issue.substring(split+1),
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
      cb(null, commits);
    });
  }

  function fetchIssues(cb){
    var issuesList = [];
    for(var i in issues){
      issuesList.push(issues[i]);
    }

    async.eachLimit(issuesList, 20, function(item, asyncCb){
        chaps.get({
          url: '/repos/' + item.repo + '/issues/' + item.number
        }, function(err, res){
          if(err || !res.body) {
            util.error(err);
          }
          // message contains any error
          if(res.body.message){
            if(res.body.message !== 'Not Found') {
              return asyncCb(res.body.message);
            }
          }
          // populate issue info
          if(res.body.title) {

            issues[item.key].title = res.body.title;
            issues[item.key].state = res.body.state;
            issues[item.key].updated_at = res.body.updated_at;
            issuesSummary[issues[item.key].state]++;

            if(res.body.milestone){
              milestones[res.body.milestone.number] = milestones[res.body.milestone.number] || {
                number: res.body.milestone.number,
                title: res.body.milestone.title,
                issues: {
                  open: res.body.milestone.open_issues,
                  closed: res.body.milestone.closed_issues,
                },
                state: res.body.milestone.state,
              };
              milestonesSummary[milestones[res.body.milestone.number].state]++;
              issues[item.key].milestone = milestones[res.body.milestone.number];
            }
          } else {
            // non-existent issue referenced in a commit
            // util.puts('no issue found:', item.key);
            delete issues[item.key];
          }
          asyncCb();
        });
      }, function(err){
        cb(err, issues);
    });
  }

  function writeLog(cb){
    var log = {}, i;
    var githubUrl = 'https://github.com/';

    // build and sort list of issues
    var issuesList = [];
    for(i in issues){
      issuesList.push(issues[i]);
    }
    issuesList.sort(function(a, b){
      return moment(b.updated_at).format('X') - moment(a.updated_at).format('X');
    });

    // build list of contributors
    var contributorsList = [];
    for(i in contributors){
      contributorsList.push(i);
    }

    // build list of milestones
    var milestonesList = [];
    for(i in milestones){
      milestonesList.push(milestones[i]);
    }

    // generate summary
    var startCommit = commits[0];
    var endCommit = commits[commits.length-1];
    var startMoment = moment.unix(startCommit.date.timestamp).zone('UTC');
    var endMoment = moment.unix(endCommit.date.timestamp).zone('UTC');
    var duration = startMoment.from(endMoment, true);
    log.summary = {
      commits: {
        start: {
          sha: startCommit.sha,
          shaAbbr: startCommit.shaAbbr,
          date: startMoment.format("YYYY-MM-DD")
        },
        end: {
          sha: endCommit.sha,
          shaAbbr: endCommit.shaAbbr,
          date: endMoment.format("YYYY-MM-DD")
        },
        total: commits.length,
        duration: duration,
        contributors: contributorsList
      },
      issues: {
        total: issuesList.length,
        open: issuesSummary.OPEN,
        closed: issuesSummary.CLOSED
      }
    };
    log.summary.desc = []
      .concat(log.summary.commits.total)
      .concat('commits');
    if(log.summary.issues.total > 0){
      log.summary.desc = log.summary.desc
      .concat('against')
      .concat(log.summary.issues.total)
      .concat('issues,');
    }
    log.summary.desc = log.summary.desc
      .concat('over')
      .concat(log.summary.commits.duration)
      .concat('[`' + log.summary.commits.start.shaAbbr + '`](' + githubUrl + repo + '/commit/' + log.summary.commits.start.shaAbbr + ')')
      .concat('-')
      .concat('[`' + log.summary.commits.end.shaAbbr + '`](' + githubUrl + repo + '/commit/' + log.summary.commits.end.shaAbbr + ')');
    log.summary.desc = log.summary.desc.join(' ');
    log.summary.release = []
      .concat('#')
      .concat(log.summary.commits.start.date)
      .concat('[**' + repo + '**](' + githubUrl + repo + ')');
    log.summary.release = log.summary.release.join(' ');

    // log list of issues
    log.issues = [];
    issuesList.forEach(function(issue){
      var line = [];
      var milestone = '';
      if(issue.milestone){
        milestone = ' <sup>[[' + issue.milestone.title + '](' + githubUrl + issue.repo + '/issues?milestone=' + issue.milestone.number + '&state=' + issue.milestone.state + ')]</sup>';
      }
      line.push('- [' + issue.state.toUpperCase() + ']');
      if(issue.foreign){
        line.push('[**' + issue.key + '**](' + githubUrl + issue.repo + '/issues/' + issue.number + ')');
      } else {
        line.push('[**#' + issue.number + '**](' + githubUrl + issue.repo + '/issues/' + issue.number + ')');
      }
      line.push(issue.title + milestone);
      log.issues.push(line.join(' '));
    });

    // log list of milestones
    log.milestones = [];
    milestonesList.forEach(function(milestone){
      var line = [];
      line.push('- [' + milestone.state.toUpperCase() + ']');
      line.push('[**' + milestone.title + '**](' + githubUrl + repo + '/issues?milestone=' + milestone.number + '&state=' + milestone.state + ')');
      log.milestones.push(line.join(' '));
    });

    // util.puts(milestonesList);
    log.summary.milestones = {
      total: milestonesList.length,
      open: milestonesSummary.OPEN,
      closed: milestonesSummary.CLOSED
    };

    // log of commits
    log.commits = [];
    commits.forEach(function(commit){
      var line = [];
      // line.push(moment.unix(commit.date.timestamp).zone('UTC').format('YYYY-MM-DD HH:mm'));
      line.push('- [**#' + commit.shaAbbr + '**](' + githubUrl + repo + '/commit/' + commit.shaAbbr + ')');
      line.push(commit.subject);
      line.push('[[' + commit.author + '](' + githubUrl + commit.author + ')]');
      log.commits.push(line.join(' '));
    });

    cb(null, log);
  }

  return function generate(range, cb) {
    setRange(range);
    async.series([
      parseRepo,
      parseGitLog,
      fetchIssues
    ], function(err){
      if(err){
        cb(err);
      } else {
        writeLog(cb);
      }
    });
  };
};
