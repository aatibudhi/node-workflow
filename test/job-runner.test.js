// Copyright 2012 Pedro P. Candel <kusorbox@gmail.com>. All rights reserved.
var util = require('util'),
    test = require('tap').test,
    uuid = require('node-uuid'),
    WorkflowJobRunner = require('../lib/job-runner'),
    Factory = require('../lib/index').Factory;

var TEST_DB_NUM = 15;

var config = {
  backend: {
    module: '../lib/workflow-redis-backend',
    opts: {
      db: TEST_DB_NUM,
      port: 6379,
      host: '127.0.0.1'
    }
  }
};

var Backend = require(config.backend.module),
    backend = new Backend(config.backend.opts),
    factory, wf_job_runner;

var okWf, failWf, timeoutWf, reQueueWf, reQueuedJob;

var FakeRunner = function() {
  this.child_processes = {};
  this.uuid = uuid();
};

FakeRunner.prototype.childUp = function(job_uuid, child_pid) {
  var self = this;
  self.child_processes[child_pid] = job_uuid;
};

FakeRunner.prototype.childDown = function(job_uuid, child_pid) {
  var self = this;
  // For real, we also want to send sigterm to the child process on job's
  // termination, therefore here we may need to upgrade on DB too.
  delete self.child_processes[child_pid];
};

var runner = new FakeRunner();

test('setup', function(t) {
  t.ok(backend, 'backend ok');
  backend.init(function() {
    backend.client.flushdb(function(err, res) {
      t.ifError(err, 'flush db error');
      t.equal('OK', res, 'flush db ok');
    });
    backend.client.dbsize(function(err, res) {
      t.ifError(err, 'db size error');
      t.equal(0, res, 'db size ok');
    });

    factory = Factory(backend);
    t.ok(factory, 'factory ok');

    // okWf:
    factory.workflow({
      name: 'OK wf',
      chain: [{
        name: 'OK Task',
        retry: 1,
        body: function(job, cb) {
          return cb(null);
        }
      }],
      timeout: 60
    }, function(err, wf) {
      t.ifError(err, 'ok wf error');
      t.ok(wf, 'OK wf OK');
      okWf = wf;
      // failWf:
      factory.workflow({
        name: 'Fail wf',
        chain: [{
          retry: 1,
          name: 'Fail Task',
          body: function(job, cb) {
            return cb('Fail task error');
          }
        }],
        timeout: 60
      }, function(err, wf) {
        t.ifError(err, 'Fail wf error');
        t.ok(wf, 'Fail wf OK');
        failWf = wf;
        factory.workflow({
          name: 'Timeout Wf',
          chain: [{
            name: 'Timeout Task',
            body: function(job, cb) {
              setTimeout(function() {
                // Should not be called:
                return cb('Error within timeout');
              }, 3050);
            }
          }],
          timeout: 3
        }, function(err, wf) {
          t.ifError(err, 'Timeout wf error');
          t.ok(wf, 'Timeout wf ok');
          timeoutWf = wf;
          factory.workflow({
            name: 'Re-Queue wf',
            chain: [{
              name: 'OK Task',
              retry: 1,
              body: function(job, cb) {
                return cb(null);
              }
            }, {
              name: 'Re-Queue Task',
              body: function(job, cb) {
                return cb('queue');
              }
            }, {
              name: 'OK Task 2',
              retry: 1,
              body: function(job, cb) {
                return cb(null);
              }
            }],
            timeout: 60
          }, function(err, wf) {
            t.ifError(err, 'ReQueue wf error');
            t.ok(wf, 'ReQueue wf ok');
            reQueueWf = wf;
            t.end();
          });
        });
      });
    });
  });
});


// TODO: tests for WorkflowJobRunner wrong opts


test('run job ok', function(t) {
  factory.job({
    workflow: okWf.uuid,
    exec_after: '2012-01-03T12:54:05.788Z'
  }, function(err, job) {
    t.ifError(err, 'job error');
    t.ok(job, 'run job ok');
    wf_job_runner = new WorkflowJobRunner({
      runner: runner,
      backend: backend,
      job: job,
      trace: false
    });
    t.ok(wf_job_runner, 'wf_job_runner ok');
    backend.runJob(job.uuid, runner.uuid, function(err) {
      t.ifError(err, 'backend.runJob error');
      wf_job_runner.run(function(err) {
        t.ifError(err, 'wf_job_runner run error');
        backend.getJob(job.uuid, function(err, job) {
          t.ifError(err, 'backend.getJob error');
          t.equal(job.execution, 'succeeded');
          t.equal(job.chain_results.length, 1);
          t.equal(job.chain_results[0].result, 'OK');
          t.end();
        });
      });

    });
  });
});


test('run a job which fails', function(t) {
  factory.job({
    workflow: failWf.uuid,
    exec_after: '2012-01-03T12:54:05.788Z'
  }, function(err, job) {
    t.ifError(err, 'job error');
    t.ok(job, 'job ok');
    wf_job_runner = new WorkflowJobRunner({
      runner: runner,
      backend: backend,
      job: job,
      trace: false
    });
    t.ok(wf_job_runner, 'wf_job_runner ok');
    backend.runJob(job.uuid, runner.uuid, function(err) {
      t.ifError(err, 'backend.runJob error');
      wf_job_runner.run(function(err) {
        t.ifError(err, 'wf_job_runner run error');
        backend.getJob(job.uuid, function(err, job) {
          t.ifError(err, 'get job error');
          t.equal(job.execution, 'failed', 'job execution');
          t.equal(job.chain_results[0].error, 'Fail task error');
          t.end();
        });
      });
    });
  });
});


test('run a job which re-queues itself', function(t) {
  factory.job({
    workflow: reQueueWf.uuid,
    exec_after: '2012-01-03T12:54:05.788Z'
  }, function(err, job) {
    t.ifError(err, 'job error');
    t.ok(job, 'run job ok');
    wf_job_runner = new WorkflowJobRunner({
      runner: runner,
      backend: backend,
      job: job,
      trace: false
    });
    t.ok(wf_job_runner, 'wf_job_runner ok');
    backend.runJob(job.uuid, runner.uuid, function(err) {
      t.ifError(err, 'backend.runJob error');
      wf_job_runner.run(function(err) {
        t.ifError(err, 'wf_job_runner run error');
        backend.getJob(job.uuid, function(err, job) {
          t.ifError(err, 'backend.getJob error');
          t.ok(job, 'job ok');
          t.equal(job.execution, 'queued');
          t.equal(job.chain_results.length, 2);
          t.equal(job.chain_results[1].result, 'OK');
          t.equal(job.chain_results[1].error, 'queue');
          reQueuedJob = job;
          t.end();
        });
      });

    });
  });
});

test('run a previously re-queued job', function(t) {
  wf_job_runner = new WorkflowJobRunner({
    runner: runner,
    backend: backend,
    job: reQueuedJob,
    trace: false
  });
  // TODO: Review elapsed time and smaller timeout
  t.ok(wf_job_runner, 'wf_job_runner ok');
  backend.runJob(reQueuedJob.uuid, runner.uuid, function(err) {
    t.ifError(err, 'backend.runJob error');
    wf_job_runner.run(function(err) {
      t.ifError(err, 'wf_job_runner run error');
      backend.getJob(reQueuedJob.uuid, function(err, job) {
        t.ifError(err, 'backend.getJob error');
        t.ok(job, 'job ok');
        t.equal(job.execution, 'succeeded');
        t.equal(job.chain_results.length, 3);
        t.equal(job.chain_results[2].result, 'OK');
        t.ifError(job.chain_results[2].error);
        t.end();
      });
    });
  });
});


test('run a job which time out', function(t) {
  factory.job({
    workflow: timeoutWf.uuid,
    exec_after: '2012-01-03T12:54:05.788Z'
  }, function(err, job) {
    t.ifError(err, 'job error');
    t.ok(job, 'job ok');
    wf_job_runner = new WorkflowJobRunner({
      runner: runner,
      backend: backend,
      job: job,
      trace: false
    });
    t.ok(wf_job_runner, 'wf_job_runner ok');
    backend.runJob(job.uuid, runner.uuid, function(err) {
      t.ifError(err, 'backend.runJob error');
      wf_job_runner.run(function(err) {
        t.ifError(err, 'wf_job_runner run error');
        backend.getJob(job.uuid, function(err, job) {
          t.ifError(err, 'get job error');
          t.equal(job.execution, 'failed', 'job execution');
          t.equal(job.chain_results[0].error, 'workflow timeout');
          t.end();
        });
      });
    });
  });
});


test('teardown', function(t) {
  backend.quit(function() {
    t.end();
  });
});

