#!/usr/bin/env node
'use strict';

const pkg = require('./package.json');
const program = require('commander');
const fs = require('fs');
const async = require('async');
const childProcess = require('child_process');
const logger = require('./logger.js');
const plist = require('plist');
const path = require('path');
const handlebars = require('handlebars');
const copydir = require('copy-dir');
const split = require('split');
const deepdiff = require('deep-diff').diff;
const readChunk = require('read-chunk');
const iOSversions = require('./ios-versions.js');

const __base = path.join(__dirname, '/');

program
  .version(pkg.version)
  .description('Incident response tool for iPhone or iPad')
  .option('--debug', 'Display debugging output');

program
  .command('extract')
  .arguments('<dir>')
  .description('Extract IR artifacts from iPhone or iPad')
  .option('-b, --backup', 'Backup iOS device')
  .option('--syslog-timeout <seconds>', 'Optional timeout for how long to collect syslong, e.g. 86400 to collect for a day')
  .action(function (dir, options) {
    if (program.debug) { logger.transports.console.level = 'debug'; }
    extractArtifacts(dir, options, function (err, runStatus) {
      if (err) {
        logger.error(err);
      } else {
        logger.info(runStatus);
      }
    });
  });

program
  .command('process')
  .arguments('<dir>')
  .description('Process extracted artifacts in <dir>')
  .action(function (dir) {
    if (program.debug) { logger.transports.console.level = 'debug'; }

    async.series({
      processArtifacts: function (callback) {
          // process device info
        logger.info('executing processArtifacts now');
        processArtifacts(dir, function (err, results) {
          if (err) {
            logger.warn('error in processArtifacts: %s', err);
          } else {
            logger.info(results);
          }
          callback(null, 'done procesing all artifacts');
        });
      },
      findIssues: function (callback) {
        logger.info('executing findIssues now');
        findIssues(dir, function (err, results) {
          if (err) {
            logger.warn(err);
          } else {
            logger.info(results);
          }
          callback(null, 'done finding issues');
        });
      }
    }, function (err, results) {
      if (err) { logger.warn(err); }
      logger.info('done processing artifacts and finding issues');
    });
  });

program
  .command('report')
  .arguments('<dir> [diffdir]')
  .description('Generate iOS IR reports from <dir>')
  .action(function (dir, diffdir) {
    if (program.debug) { logger.transports.console.level = 'debug'; }
    generateReport(dir, diffdir, function (err, runStatus) {
      if (err) {
        logger.error(err);
      } else {
        logger.info(runStatus);
      }
    });
  });

program.parse(process.argv);

// if program was called with no arguments, show help.
if (program.args.length === 0) {
  program.help();
}
// reverted check to see if command was valid. would like to get
// this to work. https://github.com/tj/commander.js/issues/57#issue-4481445

function setWorkingDirectory (userOutputDir, udid, currentEpoch) {
  let workingDir = '';
  if (userOutputDir) {
    workingDir = userOutputDir;
  } else {
    workingDir = __dirname;
  }

  const udidDir = path.join(workingDir, udid);
  const udidEpochDir = path.join(udidDir, currentEpoch);
  const artifactDir = path.join(udidEpochDir, 'artifacts');

  if (!fs.existsSync(udidDir)) {
    fs.mkdirSync(udidDir);
  }

  if (!fs.existsSync(udidEpochDir)) {
    fs.mkdirSync(udidEpochDir);
  }

  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir);
  }

  logger.info('output directory set to %s', udidEpochDir);
  return (udidEpochDir);
}

function extractArtifacts (dir, options, callback) {
  // let's first get the UDID...if we can't do this successfully, we have a problem
  getUDID(function (err, udid) {
    if (err) {
      return callback(new Error(err));
    }

    // no error getting UDID so time to fetch data
    // first we'll setup the working directory, saving data in unique dir each time based on epoch time
    const currentEpoch = new Date().getTime();
    const wd = setWorkingDirectory(dir, udid, currentEpoch.toString());

    const idevicesyslog = getDeviceSyslog(udid, wd, options.syslogTimeout);

    async.parallel({
      backup: function (callback) {
        if (options.backup) {
          doDeviceBackup(udid, wd, callback);
        } else {
          logger.info('Skipping device backup');
          // this callback() is critical so async.parallel can return
          callback();
        }
      },
      deviceInfo: function (callback) {
        getDeviceInfo(udid, wd, callback);
      },
      installedApps: function (callback) {
        getInstalledApps(udid, wd, callback);
      },
      provisioningProfiles: function (callback) {
        copyProvisioningProfiles(udid, wd, callback);
      },
      crashReports: function (callback) {
        getCrashReports(udid, wd, callback);
      }
    }, function (err, results) {
      // handle any errors from extraction functions
      if (err) { logger.error('errors encountered during extraction. error: %s\nresults: %s', err, results); }
      if (options.syslogTimeout === undefined) {
        logger.info("completed all extraction functions so we'll now kill deviceSyslog");
        idevicesyslog.kill('SIGINT');
      } else {
        logger.info('waiting %d seconds for syslog to execute', options.syslogTimeout);
      }
      callback(null, 'extract complete');
    });
  });
}

function getUDID (callback) {
  var retval = '';
  const udid = childProcess.spawn('idevice_id', ['-l']);

  udid.stdout.on('data', (chunk) => {
    // FIXME: if idevice_id fires the data event more than once the this would overwrite
    // retval which is likley problematic
    retval = chunk;
  });

  udid.on('close', code => {
    /*
    Unfortunately idevice_id returns a 0 in all situations I checked
    which differs from how ideviceinfo works. If you call idevice_id with
    an invalid parameter or no device is attached, it still returns a 0.
    I'm going to keep this return code != 0 in here for now in case they fix
    in the future. The work around is to test the length for retval and if it is
    41, then we have a UDID returned!
    */
    if (retval.length === 41) {
      // found a valid udid so return null error and uuid value
      // first let's make this a string and trim any newlines
      const udidStr = String.fromCharCode.apply(null, retval);
      logger.info('Authorized iDevice found, UDID: %s', udidStr.trim());
      callback(null, udidStr.trim());
    } else {
      // encountered some sort of error. If 0 len then no device attached, otherwise something else
      if (retval.length === 0) {
        return callback(new Error('No authorized iDevice found. Plug in and authorize a device first.'));
      } else {
        return callback(new Error(retval));
      }
    }
  });
}

function getDeviceSyslog (udid, wd, syslogTimeout) {
  const filename = 'syslog.txt';
  const file = fs.createWriteStream(wd + '/artifacts/' + filename);

  let userTimeout = 0;
  // check to see if user specified a timeout
  if (syslogTimeout) {
    // syslog timeout was specified so run with that user setting
    // FIX: add check to make sure syslogTimeout is an int or catch the conversion error
    userTimeout = Number(syslogTimeout) * 1000;
  }

  // execFile maxBuffer is set to 200k but I've overode it here to 5MB. I'll probably
  // need to change this call to exec or fork, need to research a little more
  // originally chose execFile so I could control the timeout...but we could also do
  // that in the calling function if we wanted.
  const opts = {
    timeout: userTimeout,
    maxBuffer: 5000 * 1024
  };

  // call idevicesyslog binary
  const idevicesyslog = childProcess.execFile('idevicesyslog', [], opts);

  logger.info('capturing device syslog...');

  // on data events, write chunks to file
  idevicesyslog.stdout.on('data', (chunk) => {
    file.write(chunk);
  });

  // after Stream ends, close the file, inform user of saved file
  idevicesyslog.stdout.on('end', () => {
    file.end();
    logger.debug('in getDeviceSyslog, end event fired');
  });

  idevicesyslog.on('close', function (code) {
    if (code !== 0) {
      logger.error('idevicesyslog returned error code ' + code);
      // return callback(new Error('idevicesyslog returned error code ' + code));
    } else {
      logger.debug('in getDeviceSyslog, close event triggered without error');
      logger.info('iOS Device syslog saved');
      // callback(null, idevicesyslog);
    }
  });

  // for syslog, we call back immediately and return the childProcess so the calling program
  // has control over deciding when to kill the process. Could be immediately after other
  // extraction is complete or after a timeout value
  // callback(null, idevicesyslog);
  return (idevicesyslog);
}

function getDeviceInfo (udid, wd, callback) {
  // idevice info can be run with no "domains" or domains supplied, netting more info
  // we'll build an array of domains to call and do this in a loop

  const domains = [
    '',
    'com.apple.disk_usage',
    'com.apple.disk_usage.factory',
    'com.apple.mobile.battery',
    'com.apple.iqagent',
    'com.apple.purplebuddy',
    'com.apple.PurpleBuddy',
    'com.apple.mobile.chaperone',
    'com.apple.mobile.third_party_termination',
    'com.apple.mobile.lockdownd',
    'com.apple.mobile.lockdown_cache',
    'com.apple.xcode.developerdomain',
    'com.apple.international',
    'com.apple.mobile.data_sync',
    'com.apple.mobile.tethered_sync',
    'com.apple.mobile.mobile_application_usage',
    'com.apple.mobile.backup',
    'com.apple.mobile.nikita',
    'com.apple.mobile.restriction',
    'com.apple.mobile.user_preferences',
    'com.apple.mobile.sync_data_class',
    'com.apple.mobile.software_behavior',
    'com.apple.mobile.iTunes.SQLMusicLibraryPostProcessCommands',
    'com.apple.mobile.iTunes.accessories',
    'com.apple.mobile.internal',
    'com.apple.mobile.wireless_lockdown',
    'com.apple.fairplay',
    'com.apple.iTunes',
    'com.apple.mobile.iTunes.store',
    'com.apple.mobile.iTunes'
  ];

  const baseFilename = 'ideviceinfo';
  domains.forEach(function (domain) {
    let domainAddl = '';
    if (domain !== '') {
      domainAddl = '-' + domain;
    }

    const filename = baseFilename + domainAddl + '.xml';
    const file = fs.createWriteStream(wd + '/artifacts/' + filename);

    // call ideviceinfo binary with domain extension if present
    let opts = ['--xml'];
    if (domain !== '') {
      opts.push('--domain');
      opts.push(domain);
    }
    logger.debug('calling ideviceinfo with opts: %s', opts);
    const ideviceinfo = childProcess.spawn('ideviceinfo', opts);

    // on data events, write chunks to file
    ideviceinfo.stdout.on('data', (chunk) => {
      file.write(chunk);
    });

    // after Stream ends, close the file, inform user of saved file
    ideviceinfo.stdout.on('end', () => {
      file.end();
      logger.debug('iOS Device info saved, domain: %s', domain);
      // callback(null, ideviceinfo);
    });

    // should this event be on exit or on close?
    // per documentation, not all Streams emit a close event
    // https://nodejs.org/api/stream.html#stream_event_close
    ideviceinfo.on('close', function (code) {
      if (code !== 0) {
        // return callback(new Error('Error: ideviceinfo (domain: ' + domain + ') returned error code ' + code));
        logger.error('Error: ideviceinfo (domain: %s) returned error code %s', domain, code);
      }
    });
  });
  // does this callback immediately?
  callback(null, 'complete device info extraction');
}

function getInstalledApps (udid, wd, callback) {
  const filename = 'installed-apps.xml';
  const file = fs.createWriteStream(wd + '/artifacts/' + filename);

  // call ideviceinstaller binary
  const ideviceinstaller = childProcess.spawn('ideviceinstaller', ['--list-apps', '-o', 'list_all', '-o', 'xml']);

  // on data events, write chunks to file
  ideviceinstaller.stdout.on('data', (chunk) => {
    file.write(chunk);
  });

  // after Stream ends, close the file, inform user of saved file
  ideviceinstaller.stdout.on('end', () => {
    file.end();
    logger.info('iOS Device installed apps saved');
    callback(null, ideviceinstaller);
  });

  ideviceinstaller.on('close', function (code) {
    if (code !== 0) {
      callback(new Error('ideviceinstaller returned error code ' + code));
    }
  });
}

function copyProvisioningProfiles (udid, wd, callback) {
  // ideviceprovision writes any pprofiles to disk vs. returning to stdout
  // creating a directory to store this data and putting stdout into log file
  const pprofilesDir = path.join(wd, 'artifacts', 'pprofiles');
  if (!fs.existsSync(pprofilesDir)) {
    fs.mkdirSync(pprofilesDir);
  }

  const filename = 'ideviceprovision.log';
  const file = fs.createWriteStream(pprofilesDir + filename);

  // call ideviceprovision binary
  const ideviceprovision = childProcess.spawn('ideviceprovision', ['copy', pprofilesDir]);

  // on data events, write chunks to file
  ideviceprovision.stdout.on('data', (chunk) => {
    file.write(chunk);
  });

  // after Stream ends, close the file, inform user of saved file
  ideviceprovision.stdout.on('end', () => {
    file.end();
    logger.info('Installed provisioning profiles saved');
    callback(null, ideviceprovision);
  });

  ideviceprovision.on('close', function (code) {
    if (code !== 0) {
      callback(new Error('ideviceprovision returned error code ' + code));
    }
  });
}

function getCrashReports (udid, wd, callback) {
  // idevicecrashreport writes multiple files vs. returning to stdout
  // creating a directory to store this data and putting stdout into log file
  const crashreportsDir = wd + '/artifacts/crash_reports/';
  if (!fs.existsSync(crashreportsDir)) {
    fs.mkdirSync(crashreportsDir);
  }

  const filename = 'crashlogs.txt';
  const file = fs.createWriteStream(crashreportsDir + filename);

  // call ideviceprovision binary
  const idevicecrashreport = childProcess.spawn('idevicecrashreport', ['--extract', '--keep', crashreportsDir]);

  // on data events, write chunks to file
  idevicecrashreport.stdout.on('data', (chunk) => {
    file.write(chunk);
  });

  // after Stream ends, close the file, inform user of saved file
  idevicecrashreport.stdout.on('end', () => {
    file.end();
    logger.info('Crash reports and log saved');
    callback(null, idevicecrashreport);
  });

  idevicecrashreport.on('close', function (code) {
    if (code !== 0) {
      return callback(new Error('idevicecrashreport returned error code ' + code));
    }
  });
}

function doDeviceBackup (udid, wd, callback) {
  // idevicebackup2 backup --full .
  // idevicebackup2 writes many files and directories vs. returning to stdout
  // creating a directory to store this data and putting stdout into log file
  const backupDir = wd + '/artifacts/backup/';
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir);
  }

  const filename = 'backup_log.txt';
  const file = fs.createWriteStream(backupDir + filename);

  // call ideviceprovision binary
  const idevicebackup2 = childProcess.spawn('idevicebackup2', ['backup', '--full', backupDir]);

  // on data events, write chunks to file
  idevicebackup2.stdout.on('data', (chunk) => {
    file.write(chunk);
  });

  // after Stream ends, close the file, inform user of saved file
  idevicebackup2.stdout.on('end', () => {
    file.end();
    logger.info('Device backup and log saved');
    callback(null, idevicebackup2);
  });

  idevicebackup2.on('close', function (code) {
    if (code !== 0) {
      callback(new Error('idevicebackup2 returned error code ' + code));
    }
  });
}

function processArtifacts (dir, callback) {
  const processedPath = path.join(dir, 'processed');
  const artifactPath = path.join(dir, 'artifacts');

  // if no artifact dir exists, err.
  if (!fs.existsSync(artifactPath)) {
    logger.error('No artifact directory found at %s', artifactPath);
    process.exit(1);
  } else {
    // see if processed dir exists, if so alert but continue. otherwise, create
    if (!fs.existsSync(processedPath)) {
      fs.mkdirSync(processedPath);
    } else {
      logger.warn('Processed path already exists, overwriting data in %s', path.resolve(processedPath));
    }

    async.parallel({
      artifacts: function (callback) {
    // device info
        processDeviceInfo(dir, function (err, results) {
          if (err) {
            logger.warn(err);
          } else {
            logger.info(results);
          }
          callback();
        });
      },
      apps: function (callback) {
    // installed apps
        processInstalledAppsXML(dir, function (err, results) {
          if (err) {
            logger.warn(err);
          } else {
            logger.info(results);
          }
          callback();
        });
      },
      pprofiles: function (callback) {
    // provisioning profiles
        processProvisioningProfiles(dir, function (err, results) {
          if (err) {
            logger.warn(err);
          } else {
            logger.info(results);
          }
          callback();
        });
      },
      syslog: function (callback) {
    // process syslog
        processSyslog(dir, function (err, results) {
          if (err) {
            logger.warn(err);
          } else {
            logger.info(results);
          }
          callback();
        });
      },
      crashreport: function (callback) {
    // process crash reports
        processCrashReports(dir, function (err, results) {
          if (err) {
            logger.warn(err);
          } else {
            logger.info(results);
          }
          callback();
        });
      },
      backup: function (callback) {
    // process backup
        processBackup(dir, function (err, results) {
          if (err) {
            logger.warn(err);
          } else {
            logger.info(results);
          }
          callback();
        });
      }
    }, function (err, results) {
      if (err) {
        logger.debug('in processArtifact async.parallel call final function: %s', err);
      } else {
        logger.debug('in processArtifact async.parallel call final function: %s', results);
      }
      callback('null', 'completed processArtifact async.parallel execution');
    });
  } // else
}

function processInstalledAppsXML (dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const installedAppsXML = path.join(artifactPath, 'installed-apps.xml');
  const apps = {};
  apps.summary = {};
  apps.summary.entitlements = {};
  apps.summary.privacySensitiveDataAccess = {};
  apps.summary.UIBackgroundModes = {};

  let totalApps = 0;
  let userApps = 0;
  let systemApps = 0;
  let nonAppleSigner = 0;
  let appsWithEntitlements = 0;
  let usePersistentWifi = 0;
  let requestsForPrivacySensitiveDataAccess = 0;
  let allowArbitraryLoads = 0;
  let allowArbitraryLoadsInWebContent = 0;
  let domainsAllowedArbitraryLoads = 0;
  // let domainsForceTLSLoads = 0;

  async.parallel({
    processApps: function (callback) {
      try {
        // read and parse plist file
        const obj = plist.parse(fs.readFileSync(installedAppsXML, 'utf8'));

        // full app details for inspection and comparision
        apps.details = obj;

        for (let prop in obj) {
          // every prop in array is properties for an app
          const app = obj[prop];

          totalApps++;
          for (let attrib in app) {
            switch (attrib) {
              case 'Entitlements':
                appsWithEntitlements++;
                for (let entitlement in app[attrib]) {
                  if (!(entitlement in apps.summary.entitlements)) {
                    apps.summary.entitlements[entitlement] = 0;
                  }
                  apps.summary.entitlements[entitlement]++;
                }
                break;
              case 'NSAppTransportSecurity':
                for (let transportProperty in app[attrib]) {
                  logger.debug('examining %s: ', transportProperty);
                  switch (transportProperty) {
                    case 'NSAllowsArbitraryLoads':
                      if (app[attrib][transportProperty] === true) {
                        allowArbitraryLoads++;
                      }
                      break;
                    case 'NSAllowsArbitraryLoadsInWebContent':
                      if (app[attrib][transportProperty] === true) {
                        allowArbitraryLoadsInWebContent++;
                      }
                      break;
                    case 'NSExceptionDomains':
                      for (let domain in app[attrib][transportProperty]) {
                        logger.debug('found exception for domain %s: ', domain);
                       /*
                        need to test to see if domain (normally and object) is set to null, e.g.
                          {
                          "NSExceptionDomains": {
                            "http://guide.2demo.net/": null
                          },
                            "NSAllowsArbitraryLoads": true
                          }
                        */
                        /*
                        let _allowInsecureHTTPLocal = null;
                        if ("NSExceptionAllowsInsecureHTTPLoads" in app[attrib][transportProperty][domain]) {
                          _allowInsecureHTTPLocal = app[attrib][transportProperty][domain].NSExceptionAllowsInsecureHTTPLoads;
                        };
                        logger.info("found exception for domain (%s, %s): ", domain, _allowInsecureHTTPLocal);
                        if ((_allowsInsecureHTTPLoads !== null) && (_allowsInsecureHTTPLoads === true)) {
                        */
                        domainsAllowedArbitraryLoads++;
                        /*
                        } else {
                          domainsForceTLSLoads++;
                        };
                        */
                      }
                      break;
                    default:
                      // found an unknown NSAppTransportSecurity property
                      logger.debug('found an unknown NSAppTransportSecurity property: %s', transportProperty);
                      break;
                  }
                } // for loop on NSAppTransportSecurity
                break; // NSAppTransportSecurity
              case 'UIRequiresPersistentWiFi':
                if (app[attrib] === true) {
                  usePersistentWifi++;
                }
                break;
              case 'UIBackgroundModes':
                for (let i = 0; i < app[attrib].length; i++) {
                  if (!(app[attrib][i] in apps.summary.UIBackgroundModes)) {
                    apps.summary.UIBackgroundModes[app[attrib][i]] = 0;
                  }
                  apps.summary.UIBackgroundModes[app[attrib][i]]++;
                }
                break;
              case 'SignerIdentity':
                if (app[attrib] !== 'Apple iPhone OS Application Signing') {
                  nonAppleSigner++;
                }
                break;
              case 'ApplicationType':
                switch (app[attrib]) {
                  case 'User':
                    userApps++;
                    break;
                  case 'System':
                    systemApps++;
                    break;
                  default:
                    break;
                }
                break;
              default:
                // otherwise ignore property for now
                if (attrib.endsWith('UsageDescription')) {
                  logger.debug('found an app request access to privacy-sensitive data');
                  requestsForPrivacySensitiveDataAccess++;
                  if (!(attrib in apps.summary.privacySensitiveDataAccess)) {
                    apps.summary.privacySensitiveDataAccess[attrib] = 0;
                  }
                  apps.summary.privacySensitiveDataAccess[attrib]++;
                }
                break;
            }
          }
        }
        callback(null, 'finished processing app plist');
      } catch (err) {
        // could not read apps xml or hit plist parse error
        logger.error('hit error processing app data: %s', err);
        callback(err);
      }
    }
  }, function (error, results) {
    if (error) { logger.warn('could not read or parse app data'); }

    // object for summary app data
    apps.summary.totalApps = totalApps;
    apps.summary.userApps = userApps;
    apps.summary.systemApps = systemApps;
    apps.summary.nonAppleSigner = nonAppleSigner;
    apps.summary.appsWithEntitlements = appsWithEntitlements;
    apps.summary.usePersistentWifi = usePersistentWifi;
    apps.summary.requestsForPrivacySensitiveDataAccess = requestsForPrivacySensitiveDataAccess;
    apps.summary.allowArbitraryLoads = allowArbitraryLoads;
    apps.summary.allowArbitraryLoadsInWebContent = allowArbitraryLoadsInWebContent;
    apps.summary.domainsAllowedArbitraryLoads = domainsAllowedArbitraryLoads;
    // apps.summary.domainsForceTLSLoads = domainsForceTLSLoads;

    logger.debug('installed apps xml processed, writing to %s', path.join(processedPath, 'installedApps.json'));
    const parsedAppsJSON = JSON.stringify(apps);
    fs.writeFile(processedPath + path.sep + 'apps.json', parsedAppsJSON, 'utf8', function (err) {
      if (err) {
        callback(null, 'error writing parsed app data to disk');
      } else {
        callback(null, 'wrote app data to disk');
      }
    });
  });
}

function processDeviceInfo (dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const deviceInfoXML = path.join(artifactPath, 'ideviceinfo.xml');
  const device = {};
  device.details = {};

  async.parallel({
    processDevice: function (callback) {
      try {
        // read and parse plist file
        const obj = plist.parse(fs.readFileSync(deviceInfoXML, 'utf8'));
        device.details.standard = obj;
        callback(null, 'Processed main ideviceinfo plist');
      } catch (err) {
        // could not read device xml or hit plist parse error
        callback(null, 'Hit snag processing main ideviceinfo plist');
      }
    },
    processDomains: function (callback) {
      fs.readdir(artifactPath, function (err, files) {
        if (err) {
          logger.error(err);
          callback(null, 'Hit snags processing some/all ideviceinfo domain files');
        } else {
          async.each(files, function (file, callback) {
            if (file.startsWith('ideviceinfo-')) {
              try {
                let domainName = file.slice(12, (file.length - 4)); // trim ideviceinfo- and .xml
                let domainInfo = plist.parse(fs.readFileSync(path.join(artifactPath, file), 'utf8'));
                logger.debug('for domain %s , data: %s', domainName, JSON.stringify(domainInfo));
                device.details[domainName] = domainInfo;
                callback(null, 'successful cb from async.each on domain ' + file); // cb for async.each
              } catch (err) {
                logger.error(err);
                callback(null, 'error in cb from async.each on domain ' + file + '. Error: ' + err);
              }
            } else {
              callback(null, 'not a domain file so skip');
            }
          }, function (err, results) {
            if (err) { logger.err(err); }
            logger.debug('results from ideviceinfo async.each cbs: %s', results);
            callback(null, 'processed ideviceinfo domain files');
          });
        }
      });
    }
  }, function (error, results) {
    if (error) { logger.error(error); }
    logger.debug('device info xml processed, writing to %s', path.join(processedPath, 'deviceInfo.json'));
    const deviceJSON = JSON.stringify(device);
    fs.writeFile(path.join(processedPath, 'device.json'), deviceJSON, 'utf8', function (err) {
      if (err) {
        callback(null, 'error writing parsed device and domain data to disk');
      } else {
        callback(null, 'wrote device info and domains to disk');
      }
    });
  });
}

function processProvisioningProfiles (dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const pprofilePath = path.join(artifactPath, 'pprofiles');
  // const ideviceprovisionLog = path.join(pprofilePath, 'ideviceprovision.log');
  const pprofiles = {};
  pprofiles.details = [];

  // now let's find all files in pprofilePath ending with .mobileprovision
  // and then call `ideviceprovision --xml dump` on each to get details
  fs.readdir(pprofilePath, function (err, files) {
    if (err) {
      return callback(new Error('Provisioning profiles data not processed: ' + err));
    } else {
      let count = 0;
      async.each(files, function (file, callback) {
        if (file.endsWith('.mobileprovision')) {
          logger.debug('filename: %s', file);
          count++;
          // now let's parse the pprofile xml file into a json object
          logger.debug('parsing %s', path.join(pprofilePath, file));
          let obj = {};
          try {
            obj = plist.parse(fs.readFileSync(path.join(pprofilePath, file), 'utf8'));
            pprofiles.details.push(obj);
          } catch (err) {
            /*
            sometimes it appears ideviceprovision won't be able to list a pprofile
            in this instance, let's surface to the user so addl inspection. sample output:
            profile_get_embedded_plist: unexpected profile data (0)
            (unknown id) - (no name)
            */
            logger.debug('error reading a pprofile from the device, filename: %s', file);
            obj.AppIDName = 'error reading pprofile ' + file + ' from device';
            pprofiles.details.push(obj);
          }
        }
        callback();
      }, function (err) {
        if (err) {
          logger.error(err);
        } else {
          logger.debug('pprofiles found: %d', count);
          pprofiles.summary = {
            'pprofilesFound': count
          };
          logger.debug('pprofiles processed, writing to %s', path.join(processedPath, 'pprofiles.json'));
          const pprofilesJSON = JSON.stringify(pprofiles);
          fs.writeFile(path.join(processedPath, 'pprofiles.json'), pprofilesJSON, 'utf8', function (err) {
            if (err) {
              callback(null, 'error writing pprofile data to disk');
            } else {
              callback(null, 'wrote pprofile data to disk');
            }
          });
        }
      });
    }
  });
}

function processSyslog (dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const syslogFile = path.join(artifactPath, 'syslog.txt');

  try {
    let count = 0;
    fs.createReadStream(syslogFile)
      .pipe(split())
      .on('data', function (chunk) {
        count++;
      })
      .on('end', function () {
        const syslog = {};
        syslog.summary = {
          'lines': count
        };
        logger.debug('syslog processed, writing to %s', path.join(processedPath, 'syslog.json'));
        logger.debug('syslog object: %s', JSON.stringify(syslog));
        const syslogJSON = JSON.stringify(syslog);
        fs.writeFile(path.join(processedPath, 'syslog.json'), syslogJSON, 'utf8', function (err) {
          if (err) {
            callback(null, 'error writing syslog data to disk');
          } else {
            callback(null, 'wrote syslog data to disk');
          }
        });
      });
  } catch (err) {
    return new Error('Syslog data not processed: ' + err);
  }
}

function processCrashReports (dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const crashreportPath = path.join(artifactPath, 'crash_reports');
  const crashreportLog = path.join(crashreportPath, 'crashlogs.txt');

  try {
    let count = 0;
    const filenames = [];
    fs.createReadStream(crashreportLog)
      .pipe(split())
      .on('data', function (line) {
        if (line.startsWith('Copy: ')) {
          count++;
          // example line: Copy: DiagnosticLogs/security.log.20170119T084705Z
          // split on ' ' and push the 2nd field to an array
          filenames.push(line.split(' ')[1]);
        }
      })
      .on('end', function () {
        const crashreports = {};
        crashreports.summary = {
          'reports': count,
          'filenames': filenames
        };
        crashreports.details = [];

        // read each log file to get properties and
        for (let i = 0; i < crashreports.summary.filenames.length; i++) {
          let filename = path.join(crashreportPath, crashreports.summary.filenames[i]);
          logger.debug('time to get details on %s', filename);
          let fileStats = fs.statSync(filename);
          let preview = 'Empty file';
          if (fileStats.size > 0) {
            if (fileStats.size < 500) {
              preview = readChunk.sync(filename, 0, fileStats.size);
            } else {
              preview = readChunk.sync(filename, 0, 500);
            }
          }
          let fileDetails = {};
          fileDetails.filename = crashreports.summary.filenames[i];
          fileDetails.size = fileStats.size;
          fileDetails.preview = preview.toString().split('\n');
          crashreports.details.push(fileDetails);
        }

        // write processed artifact data
        logger.debug('crash report data processed, writing to %s', path.join(processedPath, 'crashreports.json'));
        logger.debug('crashreports object: %s', JSON.stringify(crashreports));
        const crashreportsJSON = JSON.stringify(crashreports);
        fs.writeFile(path.join(processedPath, 'crashreports.json'), crashreportsJSON, 'utf8', function (err) {
          if (err) {
            callback(null, 'error writing crash report data to disk');
          } else {
            callback(null, 'wrote crash report data to disk');
          }
        });
      });
  } catch (err) {
    return new Error('Crash report data not processed: ' + err);
  }
}

function processBackup (dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const backupPath = path.join(artifactPath, 'backup');
  const backupFile = path.join(backupPath, 'backup_log.txt');
  const backup = {};

  let backupFileCount = 0;
  fs.createReadStream(backupFile)
    // handled the error event before pipe, I guess order matters here
    .on('error', function () {
      // not flagging as error, just going to write a blank backup object
      logger.info('Backup dir not found, skipping processing');
      const backupJSON = JSON.stringify(backup);
      fs.writeFile(path.join(processedPath, 'backup.json'), backupJSON, 'utf8', function (err) {
        if (err) {
          callback(null, 'error writing parsed backup data to disk');
        } else {
          callback(null, 'wrote parsed backup data to disk');
        }
      });
    })
    .pipe(split())
    .on('data', function (line) {
      if (line.startsWith('Received ')) {
        // example line: Received 623 files from device.
        // split on ' ' and push the 2nd field to an array
        logger.debug('found file count in backup log: [%s]', line);
        backupFileCount = line.split(' ')[1];
      }
    })
    .on('end', function () {
      backup.summary = {
        'files': backupFileCount
      };
      logger.debug('backup processed, writing to %s', path.join(processedPath, 'backup.json'));
      logger.debug('backup object: %s', JSON.stringify(backup));
      const backupJSON = JSON.stringify(backup);
      fs.writeFile(path.join(processedPath, 'backup.json'), backupJSON, 'utf8', function (err) {
        if (err) {
          callback(null, 'error writing parsed backup data to disk');
        } else {
          callback(null, 'wrote parsed backup data to disk');
        }
      });
    });
}

function readProcessedJSON (dir, loadIssues) {
  // since we reuse readProcessedJSON, we don't always have an issues.json
  // use the loadIssues boolean to determine if we should try to read that file

  const processedPath = path.join(dir, 'processed');

  // read json data files to pass to handlebar template
  const deviceFile = path.join(processedPath, 'device.json');
  const appsFile = path.join(processedPath, 'apps.json');
  const pprofilesJSONFile = path.join(processedPath, 'pprofiles.json');
  const syslogJSONFile = path.join(processedPath, 'syslog.json');
  const crashreportsJSONFile = path.join(processedPath, 'crashreports.json');
  const backupJSONFile = path.join(processedPath, 'backup.json');
  const issuesJSONFile = path.join(processedPath, 'issues.json');

  let issuesJSON = {};
  const data = {};

  try {
    const deviceJSON = fs.readFileSync(deviceFile, 'utf8');
    const appsJSON = fs.readFileSync(appsFile, 'utf8');
    const pprofilesJSON = fs.readFileSync(pprofilesJSONFile, 'utf8');
    const syslogJSON = fs.readFileSync(syslogJSONFile, 'utf8');
    const crashreportsJSON = fs.readFileSync(crashreportsJSONFile, 'utf8');
    const backupJSON = fs.readFileSync(backupJSONFile, 'utf8');
    if (loadIssues) {
      issuesJSON = fs.readFileSync(issuesJSONFile, 'utf8');
    }

    data.cli = pkg.name + ' v' + pkg.version;
    data.device = JSON.parse(deviceJSON);
    data.apps = JSON.parse(appsJSON);
    data.pprofiles = JSON.parse(pprofilesJSON);
    data.syslog = JSON.parse(syslogJSON);
    data.crashreports = JSON.parse(crashreportsJSON);
    data.backup = JSON.parse(backupJSON);
    if (loadIssues) {
      data.issues = JSON.parse(issuesJSON);
    }
    return data;
  } catch (err) {
    logger.error(err);
    return data;
  }
}

function findIssues (dir, callback) {
  const processedPath = path.join(dir, 'processed');
  const data = readProcessedJSON(dir, false);
  const issues = {};
  issues.summary = {};
  issues.details = [];
  let issueCount = 0;

  if (!data.device.details.standard.PasswordProtected) {
    issueCount++;
    let issueDetails = {};
    issueDetails.title = 'Device not password protected';
    issueDetails.level = 'medium';
    issueDetails.description = 'This device does is not password protected. The device is more suseptible to compromise if an attacker can briefly gain physical access. THese risks include the ability to extract data from the device (using backup, forensic or maybe even ios-triage!) and run applications. In addition, sensitive data encrypted at rest by the iDevice and apps lack an additional level of security.';
    issueDetails.remediation = 'Password protext the device, ideally with an alphanumeric passcode or a PIN at least 6 digits long';
    issues.details.push(issueDetails);
  }

  if (data.device.details.standard.ProductVersion !== iOSversions.LATEST_IOS_VERSION) {
    issueCount++;
    let issueDetails = {};
    issueDetails.title = 'iOS version out of date';
    issueDetails.level = 'high';
    issueDetails.description = 'This device is not running the latest version of iOS. Apple regularly patches security flaws in iOS and the flaws are publicly acknowledged (see https://support.apple.com/en-us/HT207482 for 10.2.1 security update). Attackers can leverage this information to compromise your device and data.';
    issueDetails.remediation = 'Update your device to the latest available version immediately (currently ' + iOSversions.LATEST_IOS_VERSION + '). If you are running on older hardware and newer iOS versions are unavailable, it is recommended you move to a new device.';
    issues.details.push(issueDetails);
  }

  if (data.pprofiles.summary.pprofilesFound > 0) {
    issueCount++;
    let issueDetails = {};
    issueDetails.title = 'Provisioning profiles found';
    issueDetails.level = 'medium';
    issueDetails.description = 'Install provisioning profiles can create situations for abuse. An attacker with physical access could push an app onto your device with significant privileges.';
    issueDetails.remediation = 'Inspect all provisioning profiles to ensure they are legitimate.';
    issues.details.push(issueDetails);
  }

  if (data.apps.summary.nonAppleSigner > 0) {
    issueCount++;
    let issueDetails = {};
    issueDetails.title = 'Developer signed apps found';
    issueDetails.level = 'medium';
    issueDetails.description = 'This device contains developer signed apps. There apps circumvent the App Store review and could possible contain malicious code.';
    issueDetails.remediation = 'Inspect all non-Apple signed apps to ensure they are legitimate.';
    issues.details.push(issueDetails);
  }

  issues.summary.count = issueCount;
  logger.debug('findIssues complete, writing to %s', path.join(processedPath, 'issues.json'));
  logger.debug('issues object: %s', JSON.stringify(issues));
  const issuesJSON = JSON.stringify(issues);
  fs.writeFile(path.join(processedPath, 'issues.json'), issuesJSON, 'utf8', function (err) {
    if (err) {
      callback(null, 'error writing issues.json to disk');
    } else {
      callback(null, 'wrote issues.json to disk');
    }
  });
}

function generateReport (dir, diffdir, callback) {
  const processedPath = path.join(dir, 'processed');
  const artifactPath = path.join(dir, 'artifacts');
  const reportPath = path.join(dir, 'reports');
  const cssPath = path.join(reportPath, 'assets', 'dist', 'css');

  let dataRhs = null;
  let doDiff = false;
  let diffdirProcessedPath = null;
  if (diffdir) {
    diffdirProcessedPath = path.join(diffdir, 'processed');
    doDiff = true;
  }

  // if no artifact dir exists, err.
  if (!fs.existsSync(artifactPath)) {
    return callback('No artifact directory found, run `ios-triage extract <dir>` first');
  } else {
    // see if processed dir exists, if so alert but continue. otherwise, create
    if (!fs.existsSync(processedPath)) {
      return callback('No processed directory found, run `ios-triage process <dir>` first');
    } else {
      // if diffdir is passed in, check to see if processed dir exists there for diff'ing
      if (doDiff) {
        if (fs.existsSync(diffdirProcessedPath)) {
          logger.info('will diff with artifacts from %s', diffdirProcessedPath);
          doDiff = true;
          dataRhs = readProcessedJSON(diffdir, true);
        } else {
          doDiff = false;
          logger.warn("DiffDir processed path %s doesn't exist, not diff'ing", diffdirProcessedPath);
        }
      }

      // create report dir and copy assests if needed
      if (!fs.existsSync(reportPath)) {
        fs.mkdirSync(reportPath);
      }

      // copy assets to report dir if needed, assuming if css dir exists files were copied
      // a user could muck this up if they tinker in those dirs but punting for now
      if (!fs.existsSync(cssPath)) {
        const pkgAssetPath = path.join(__base, 'html', 'bootstrap4');
        copydir.sync(pkgAssetPath, reportPath);
      }

      const data = readProcessedJSON(dir, true);
      if (doDiff) {
        const diff = deepdiff(data, dataRhs);
        data.diff = diff;
      }

      logger.debug(JSON.stringify(data));

      // register handlebarsjs partial files
      const partials = ['header', 'topnavbar', 'footer', 'detailstabs'];
      partials.forEach(function (item) {
        let partialFile = __base + 'html/templates/partials/' + item + '.hbs';
        let partial = handlebars.compile(fs.readFileSync(partialFile, 'utf-8'));
        handlebars.registerPartial(item, partial);
      });

      // register helpers
      handlebars.registerHelper('toJSON', function (object) {
        return new handlebars.SafeString(JSON.stringify(object));
      });

      // compile handlebarsjs templates, need to add diff json data files next
      const templateList = ['index', 'issues', 'diffs', 'community', 'apps', 'device', 'crashreports', 'pprofiles', 'artifacts'];
      templateList.forEach(function (templateName) {
        let templateFile = __base + 'html/templates/' + templateName + '.hbs';
        logger.debug('reading temple file: %s', templateFile);
        fs.readFile(templateFile, 'utf-8', function (error, source) {
          logger.debug('source is type: %s', Object.prototype.toString.apply(source));
          const template = handlebars.compile(source);
          const html = template(data);
          // copy html to <dir>/reports/index.html
          const htmlFile = path.join(reportPath, templateName + '.html');
          fs.writeFile(htmlFile, html, 'utf8', function (err) {
            if (err) {
              logger.error('error writing html file (%s) disk with error: %s', htmlFile, err);
            }
          });
          if (error) { logger.error('Error reading template file %s, error details: %s', templateFile, error); }
        });
      });
      callback(null, 'report saved to ' + path.resolve(path.join(reportPath, 'index.html')));
    }
  }
}

