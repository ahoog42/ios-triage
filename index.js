#!/usr/bin/env node
'use strict';

const pkg = require('./package.json');
const program = require('commander');
const fs = require('fs');
const os = require('os');
const async = require('async');
const child_process = require('child_process');
const logger = require('./logger.js');
const plist = require('plist');
const path = require('path');
const handlebars = require('handlebars');
const copydir = require('copy-dir');
const split = require('split');

global.__base = __dirname + '/';

program
  .version(pkg.version)
  .description('Incident response tool for iPhone or iPad')
  .option('--debug', 'Display debugging output')

program
  .command('extract')
  .arguments('<dir>')
  .description('Extract IR artifacts from iPhone or iPad')
  .option('-b, --backup', 'Backup iOS device')
  .option('--syslog-timeout <seconds>', 'Optional timeout for how long to collect syslong, e.g. 86400 to collect for a day')
  .action(function(dir, options) {
    if (program.debug) { logger.transports.console.level = 'debug'; };
    extractArtifacts(dir, options, function(err, runStatus) {
      if (err) { 
        logger.error(err);
      } else {
        logger.info(runStatus);
      };
    });
  });

program
  .command('process')
  .arguments('<dir>')
  .description('Process extracted artifacts in <dir>')
  .action(function(dir) {
    if (program.debug) { logger.transports.console.level = 'debug'; };

async.series({
    processArtifacts: function(callback) {
      // process device info
      processArtifacts(dir, function(err, results) {
        if (err) {
          logger.warn(err);
        } else {
          logger.info(results);
        };
        callback(null, "done procesing all artifacts");
      });
    },
    findIssues: function(callback) {
      findIssues(dir, function(err, results) {
        if (err) {
          logger.warn(err);
        } else {
          logger.info(results);
        };
        callback(null, "done finding issues");
      });
    }
}, function(err, results) {
      if (err) { logger.warn(err); };
      logger.info("done processing artifacts and finding issues");
    });

  });

program
  .command('report')
  .arguments('<dir>')
  .description('Generate iOS IR reports from <dir>')
  .action(function(dir) {
    if (program.debug) { logger.transports.console.level = 'debug'; };
    generateReport(dir, function(err, runStatus) {
      if (err) { 
        logger.error(err); 
      } else {
        logger.info(runStatus);
      };
    });
  });

program.parse(process.argv);

// if program was called with no arguments, show help.
if (program.args.length === 0) {
  program.help();
};
// reverted check to see if command was valid. would like to get
// this to work. https://github.com/tj/commander.js/issues/57#issue-4481445


function setWorkingDirectory (userOutputDir, udid, currentEpoch) {
  let wd = "";
  if (userOutputDir) {
    wd = userOutputDir;
  } else {
    wd = __dirname;
  };

  // need to move away from "/" and start using path.sep
  const wd_udid = wd + "/" + udid;
  const wd_udid_epoch = wd_udid + '/' + currentEpoch;

  if (!fs.existsSync(wd_udid)){
    fs.mkdirSync(wd_udid);
  };

  if (!fs.existsSync(wd_udid_epoch)){
    fs.mkdirSync(wd_udid_epoch);
  };

  if (!fs.existsSync(wd_udid_epoch + '/artifacts')){
    fs.mkdirSync(wd_udid_epoch + '/artifacts');
  };

  logger.info("output directory set to %s", wd_udid_epoch);
  return(wd_udid_epoch);
}

function extractArtifacts(dir, options, callback) {
  // let's first get the UDID...if we can't do this successfully, we have a problem 
  getUDID(function (err, udid) {
    if (err) { 
      return callback(new Error(err)); 
    };

    // no error getting UDID so time to fetch data
    // first we'll setup the working directory, saving data in unique dir each time based on epoch time
    const currentEpoch = new Date().getTime(); 
    const wd = setWorkingDirectory(dir, udid, currentEpoch);

    const idevicesyslog = getDeviceSyslog(udid, wd, options.syslogTimeout); 

    async.parallel({
      backup: function(callback) {
        if (options.backup) {
          doDeviceBackup(udid, wd, callback);
        } else {
          logger.info("Skipping device backup");
          // this callback() is critical so async.parallel can return
          callback();
        }
      },
      deviceInfo: function(callback) {
        getDeviceInfo(udid, wd, callback);
      },
      installedApps: function(callback) {
        getInstalledApps(udid, wd, callback);
      },
      provisioningProfiles: function(callback) {
        copyProvisioningProfiles(udid, wd, callback);
      },
      crashReports: function(callback) {
        getCrashReports(udid, wd, callback);
      }
    }, function(err, results) {
      //handle any errors from extraction functions
      if(options.syslogTimeout === undefined) {
        logger.info("completed all extraction functions so we'll now kill deviceSyslog");
        idevicesyslog.kill('SIGINT');
      } else {
        logger.info("waiting %d seconds for syslog to execute", options.syslogTimeout);
      };
      callback(null, 'extract complete');
    }); 
  });
};

function getUDID (callback) {
  var retval = ''; 
  const udid = child_process.spawn('idevice_id', ['-l']);

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
      const udid_str = String.fromCharCode.apply(null, retval);
      logger.info("Authorized iDevice found, UDID: %s", udid_str.trim());
      callback(null, udid_str.trim());
    } else {
      // encountered some sort of error. If 0 len then no device attached, otherwise something else
      if (retval.length === 0) {
        return callback(new Error("No authorized iDevice found. Plug in and authorize a device first."));
      } else {
        return callback(new Error(retval));
      };
    };
  });
};

function getDeviceSyslog(udid, wd, syslogTimeout) { 

  const file_name = 'syslog.txt';
  const file = fs.createWriteStream(wd + '/artifacts/' + file_name);

  let userTimeout = 0;
  // check to see if user specified a timeout
  if (syslogTimeout) {
    // syslog timeout was specified so run with that user setting 
    // FIX: add check to make sure syslogTimeout is an int or catch the conversion error
    userTimeout = Number(syslogTimeout)*1000;
  };

  // execFile maxBuffer is set to 200k but I've overode it here to 5MB. I'll probably
  // need to change this call to exec or fork, need to research a little more
  // originally chose execFile so I could control the timeout...but we could also do
  // that in the calling function if we wanted.
  const opts = {
    timeout: userTimeout,
    maxBuffer: 5000*1024
  };

  // call idevicesyslog binary
  const idevicesyslog = child_process.execFile('idevicesyslog', [], opts );

  logger.info("capturing device syslog...");

  // on data events, write chunks to file
  idevicesyslog.stdout.on('data', (chunk) => { 
    file.write(chunk); 
  });

  // after Stream ends, close the file, inform user of saved file
  idevicesyslog.stdout.on('end', () => { 
    file.end(); 
    logger.debug("in getDeviceSyslog, end event fired");
  });

  idevicesyslog.on('close', function(code) {
    if (code != 0) {
      logger.error("idevicesyslog returned error code " + code);
      // return callback(new Error('idevicesyslog returned error code ' + code));
    } else {
      logger.debug("in getDeviceSyslog, close event triggered without error");
      logger.info('iOS Device syslog saved');
      // callback(null, idevicesyslog);
    }
  });

  // for syslog, we call back immediately and return the childProcess so the calling program
  // has control over deciding when to kill the process. Could be immediately after other
  // extraction is complete or after a timeout value
  //callback(null, idevicesyslog);
  return(idevicesyslog);
};

function getDeviceInfo(udid, wd, callback) { 

  // idevice info can be run with no "domains" or domains supplied, netting more info
  // we'll build an array of domains to call and do this in a loop

  const domains = [
    "", 
    "com.apple.disk_usage", 
    "com.apple.disk_usage.factory", 
    "com.apple.mobile.battery", 
    "com.apple.iqagent", 
    "com.apple.purplebuddy", 
    "com.apple.PurpleBuddy", 
    "com.apple.mobile.chaperone", 
    "com.apple.mobile.third_party_termination", 
    "com.apple.mobile.lockdownd", 
    "com.apple.mobile.lockdown_cache", 
    "com.apple.xcode.developerdomain", 
    "com.apple.international", 
    "com.apple.mobile.data_sync", 
    "com.apple.mobile.tethered_sync", 
    "com.apple.mobile.mobile_application_usage", 
    "com.apple.mobile.backup", 
    "com.apple.mobile.nikita", 
    "com.apple.mobile.restriction", 
    "com.apple.mobile.user_preferences", 
    "com.apple.mobile.sync_data_class", 
    "com.apple.mobile.software_behavior", 
    "com.apple.mobile.iTunes.SQLMusicLibraryPostProcessCommands", 
    "com.apple.mobile.iTunes.accessories", 
    "com.apple.mobile.internal", 
    "com.apple.mobile.wireless_lockdown", 
    "com.apple.fairplay", 
    "com.apple.iTunes", 
    "com.apple.mobile.iTunes.store", 
    "com.apple.mobile.iTunes"
  ];

  const baseFilename = 'ideviceinfo';
  domains.forEach(function (domain) {
    let domainAddl = "";
    if (domain !== "") {
      domainAddl = '-' + domain;
    };
    
    const filename = baseFilename + domainAddl + '.xml';
    const file = fs.createWriteStream(wd + '/artifacts/' + filename);

    // call ideviceinfo binary with domain extension if present
    let opts = ['--xml'];
    if (domain !== "") {
      opts.push('--domain'); 
      opts.push(domain);
    };
    logger.debug('calling ideviceinfo with opts: %s', opts);
    const ideviceinfo = child_process.spawn('ideviceinfo', opts);

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
    ideviceinfo.on('close', function(code) {
      if (code != 0) {
        // return callback(new Error('Error: ideviceinfo (domain: ' + domain + ') returned error code ' + code));
        logger.error('Error: ideviceinfo (domain: %s) returned error code %s', domain, code);
      }
    });
  });
  // does this callback immediately?
  callback(null, "complete device info extraction");
};

function getInstalledApps(udid, wd, callback) { 

  const file_name = 'installed-apps.xml';
  const file = fs.createWriteStream(wd + '/artifacts/' + file_name);

  // call ideviceinstaller binary
  const ideviceinstaller = child_process.spawn('ideviceinstaller', ['--list-apps', '-o','list_all', '-o', 'xml']);

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

  ideviceinstaller.on('close', function(code) {
    if (code != 0) {
      callback(new Error('ideviceinstaller returned error code ' + code));
    }
  });
};

function copyProvisioningProfiles(udid, wd, callback) { 

  // ideviceprovision writes any pprofiles to disk vs. returning to stdout
  // creating a directory to store this data and putting stdout into log file
  const wd_pprofiles = path.join(wd, 'artifacts', 'pprofiles');
  if (!fs.existsSync(wd_pprofiles)){
    fs.mkdirSync(wd_pprofiles);
  }

  const file_name = 'ideviceprovision.log';
  const file = fs.createWriteStream(wd_pprofiles + file_name);

  // call ideviceprovision binary
  const ideviceprovision = child_process.spawn('ideviceprovision', ['copy', wd_pprofiles]);

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

  ideviceprovision.on('close', function(code) {
    if (code != 0) {
      callback(new Error('ideviceprovision returned error code ' + code));
    }
  });
};

function getCrashReports(udid, wd, callback) { 

  // idevicecrashreport writes multiple files vs. returning to stdout
  // creating a directory to store this data and putting stdout into log file
  const wd_crashreports = wd + '/artifacts/crash_reports/';
  if (!fs.existsSync(wd_crashreports)){
    fs.mkdirSync(wd_crashreports);
  }

  const file_name = 'crashlogs.txt';
  const file = fs.createWriteStream(wd_crashreports + file_name);

  // call ideviceprovision binary
  const idevicecrashreport = child_process.spawn('idevicecrashreport', ['--extract', '--keep', wd_crashreports]);

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

  idevicecrashreport.on('close', function(code) {
    if (code != 0) {
      return callback(new Error('idevicecrashreport returned error code ' + code));
    }
  });
};

function doDeviceBackup(udid, wd, callback) { 
  // idevicebackup2 backup --full .
  // idevicebackup2 writes many files and directories vs. returning to stdout
  // creating a directory to store this data and putting stdout into log file
  const wd_backup = wd + '/artifacts/backup/';
  if (!fs.existsSync(wd_backup)){
    fs.mkdirSync(wd_backup);
  }

  const file_name = 'backup_log.txt';
  const file = fs.createWriteStream(wd_backup + file_name);

  // call ideviceprovision binary
  const idevicebackup2 = child_process.spawn('idevicebackup2', ['backup', '--full', wd_backup]);

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

  idevicebackup2.on('close', function(code) {
    if (code != 0) {
      callback(new Error('idevicebackup2 returned error code ' + code));
    }
  });
};

function processArtifacts(dir, callback) {
  const processedPath = path.join(dir, 'processed');
  const artifactPath = path.join(dir, 'artifacts');

  // if no artifact dir exists, err. 
  if (!fs.existsSync(artifactPath)) {
    return callback("No artifact directory found at " + artifactPath);
  } else {  
    // see if processed dir exists, if so alert but continue. otherwise, create
    if (!fs.existsSync(processedPath)) {
     fs.mkdirSync(processedPath);
    } else {
      logger.warn('Processed path already exists, overwriting data in %s', path.resolve(processedPath));
    };

    // device info
    processDeviceInfo(dir, function(err, results) {
      if (err) {
        logger.warn(err);
      } else {
        logger.info(results);
      };
    });

    // installed apps
    processInstalledAppsXML(dir, function(err, results) {
      if (err) {
        logger.warn(err);
      } else {
        logger.info(results);
      };
   });

    // provisioning profiles
    processProvisioningProfiles(dir, function(err, results) {
      if (err) {
        logger.warn(err);
      } else {
        logger.info(results);
      };
   });

    // process syslog 
    processSyslog(dir, function(err, results) {
      if (err) {
        logger.warn(err);
      } else {
        logger.info(results);
      };
   });

    // process crash reports 
    processCrashReports(dir, function(err, results) {
      if (err) {
        logger.warn(err);
      } else {
        logger.info(results);
      };
   });

    // process backup  
    processBackup(dir, function(err, results) {
      if (err) {
        logger.warn(err);
      } else {
        logger.info(results);
      };
   });
  };
};

function processInstalledAppsXML(dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const installedAppsXML = path.join(artifactPath, 'installed-apps.xml');
  const apps = {};

  let totalApps = 0;
  let userApps = 0;
  let systemApps = 0;
  let nonAppleSigner = 0;

  async.parallel({
    processApps: function(callback) {
      try {
        // read and parse plist file
        const obj = plist.parse(fs.readFileSync(installedAppsXML, 'utf8'));

        // full app details for inspection and comparision
        apps.details = obj;

        for (let prop in obj) {
          // every prop in array is properties for an app
          const app = obj[prop];
          let appInfo = {}; //object to store individual app properties in

          totalApps++;
          for(let attrib in app) {
            switch(attrib) {
              case "SignerIdentity":
                if(app[attrib] !== "Apple iPhone OS Application Signing") {
                  nonAppleSigner++;
                }
                break;
              case "ApplicationType":
                switch(app[attrib]) {
                  case "User":
                    userApps++;
                    break;
                  case "System":
                    systemApps++;
                    break;
                  default:
                    break;
                };
                break;
              default:
                // otherwise ignore property for now
                break;
            };
          };
        };
        callback();
      } catch (err) {
        // could not read apps xml or hit plist parse error
        callback(err);
      };
    }
  }, function (error, results) {
    if (error) { logger.warn("could not read or parse app data"); }
    // object for summary app data
    apps.summary = {
      "totalApps": totalApps,
      "userApps": userApps,
      "systemApps": systemApps,
      "nonAppleSigner": nonAppleSigner
    };
    logger.debug("installed apps xml processed, writing to %s", path.join(processedPath, 'installedApps.json'));
    const parsedAppsJSON = JSON.stringify(apps);
    // FIXME should catch errors, maye use callbacks?
    fs.writeFile(processedPath + path.sep + 'apps.json', parsedAppsJSON, 'utf8');
    callback(null, "processed app data"); 
  });
};

function processDeviceInfo(dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const deviceInfoXML = path.join(artifactPath, 'ideviceinfo.xml');
  const device = {};
  device.details = {};

  async.parallel({
    processDevice: function(callback) {
      try {
        // read and parse plist file
        const obj = plist.parse(fs.readFileSync(deviceInfoXML, 'utf8'));
        device.details.standard = obj;
        callback(null, "Processed main ideviceinfo plist");
      } catch (err) {
        // could not read device xml or hit plist parse error
        callback(null, "Hit snag processing main ideviceinfo plist");
      };
    },
    processDomains: function(callback) {
      fs.readdir(artifactPath, function(err, files) {
        if (err) {
          logger.error(err)
          callback(null, "Hit snags processing some/all ideviceinfo domain files");
        } else {
          async.each(files, function (file, callback) {
            if (file.startsWith('ideviceinfo-')) {
              try {
                let domainName = file.slice(12, (file.length - 4)); // trim ideviceinfo- and .xml
                let domainInfo = plist.parse(fs.readFileSync(path.join(artifactPath, file), 'utf8'));
                logger.debug("for domain %s , data: %s", domainName , JSON.stringify(domainInfo));
                device.details[domainName] = domainInfo;
                callback(null, "successful cb from async.each on domain " + file); // cb for async.each
              } catch (err) {
                logger.error(err);
                callback(null, "error in cb from async.each on domain " + file + ". Error: " + err);
              }
            } else {
              callback(null, "not a domain file so skip");
            }
          }, function(err, results) {
            if (err) { logger.err(err); };
            logger.debug("results from ideviceinfo async.each cbs: %s", results);
            callback(null, "processed ideviceinfo domain files");
          });
        };
      });
    } 
  }, function (error, results) {
      if (error) { logger.error(error); };
      logger.debug("device info xml processed, writing to %s", path.join(processedPath, 'deviceInfo.json'));
      const deviceJSON = JSON.stringify(device);
      // FIXME should catch errors, maye use callbacks?
      fs.writeFile(path.join(processedPath, 'device.json'), deviceJSON, 'utf8');
      callback(null,"processed device info and domains");
  });
};
  
function processProvisioningProfiles(dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const pprofilePath = path.join(artifactPath, 'pprofiles');
  const ideviceprovisionLog = path.join(pprofilePath, 'ideviceprovision.log');
  const pprofiles = {};
  pprofiles.details = [];

  // now let's find all files in pprofilePath ending with .mobileprovision
  // and then call `ideviceprovision --xml dump` on each to get details
  fs.readdir(pprofilePath, function(err, files) {
    if (err) {
      return callback(new Error("Provisioning profiles data not processed: " + err));
    } else {
      let count = 0;
      async.each(files, function (file, callback) {
        if (file.endsWith('.mobileprovision')) {
          logger.debug('filename: %s', file);
          count++;
          // now let's parse the pprofile xml file into a json object
          logger.debug('parsing %s', path.join(pprofilePath,file));
          let obj = plist.parse(fs.readFileSync(path.join(pprofilePath,file), 'utf8'));
          pprofiles.details.push(obj);
        };
        callback();
      }, function(err) {
        if (err) {
          logger.error(err);
        } else {
          logger.debug("pprofiles found: %d", count);
          pprofiles.summary = {
            "pprofilesFound": count
          };
          logger.debug("pprofiles processed, writing to %s", path.join(processedPath, 'pprofiles.json'));
          const pprofilesJSON = JSON.stringify(pprofiles);
          // FIXME should catch errors, maye use callbacks?
          fs.writeFile(path.join(processedPath,'pprofiles.json'), pprofilesJSON, 'utf8');
          callback(null,"processed pprofiles");
        }; 
      });
    };
  });
};

function processSyslog(dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const syslogFile = path.join(artifactPath, 'syslog.txt');

  try {
    let count = 0;
    fs.createReadStream(syslogFile)
      .pipe(split())
      .on('data', function(chunk) {
          count++;
      })
      .on('end', function() {
        const syslog = {};
        syslog.summary = {
          "lines": count
        };
        logger.debug("syslog processed, writing to %s", path.join(processedPath, 'syslog.json'));
        logger.debug('syslog object: %s', JSON.stringify(syslog));
        const syslogJSON = JSON.stringify(syslog);
        // FIXME should catch errors, maybe use callbacks?
        fs.writeFile(path.join(processedPath, 'syslog.json'), syslogJSON, 'utf8');
        callback(null, 'syslog data processed');
      });
  } catch(err) {
      return new Error("Syslog data not processed: " + err);
  };
};

function processCrashReports(dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const crashreportPath = path.join(artifactPath, 'crash_reports');
  const crashreportLog = path.join(crashreportPath, 'crashlogs.txt');


  try {
    let count = 0;
    const filenames = [];
    fs.createReadStream(crashreportLog)
      .pipe(split())
      .on('data', function(line) {
        if (line.startsWith('Copy: ')) {
          count++;
          // example line: Copy: DiagnosticLogs/security.log.20170119T084705Z
          // split on ' ' and push the 2nd field to an array
          filenames.push(line.split(' ')[1]);
        }
      })
      .on('end', function() {
        const crashreports = {};
        crashreports.summary = {
          "reports": count,
          "filenames": filenames
        };
        logger.debug("crash report data processed, writing to %s", path.join(processedPath, 'crashreports.json'));
        logger.debug('crashreports object: %s', JSON.stringify(crashreports));
        const crashreportsJSON = JSON.stringify(crashreports);
        // FIXME should catch errors, maybe use callbacks?
        fs.writeFile(path.join(processedPath, 'crashreports.json'), crashreportsJSON, 'utf8');
        callback(null, 'crash report data processed');
      });
  } catch(err) {
      return new Error("Crash report data not processed: " + err);
  };
};

function processBackup(dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const backupPath = path.join(artifactPath, 'backup');
  const backupFile = path.join(backupPath, 'backup_log.txt');
  const backup = {};

  async.parallel({
    processLog: function(callback) {
      let backupFileCount = 0;
      fs.createReadStream(backupFile)
        // handled the error event before pipe, I guess order matters here
        .on('error', function() {
          // not flagging as error, just going to write a blank backup object
          callback(null, "Backup dir not found, skipping processing");
        })
        .pipe(split())
        .on('data', function(line) {
          if (line.startsWith('Received ')) {
            // example line: Received 623 files from device. 
            // split on ' ' and push the 2nd field to an array
            logger.debug('found file count in backup log: [%s]',line);
            backupFileCount = line.split(' ')[1];
          }
        })
        .on('end', function() {
          backup.summary = {
            "files": backupFileCount
          };
          callback(null, 'backup data processed');
        });
      }
    }, function (error, results) {
      //write backup object here
      logger.info(results.processLog);
      logger.debug("backup processed, writing to %s", path.join(processedPath, 'backup.json'));
      logger.debug('backup object: %s', JSON.stringify(backup));
      const backupJSON = JSON.stringify(backup);
      // FIXME should catch errors, maybe use callbacks?
      fs.writeFile(path.join(processedPath, 'backup.json'), backupJSON, 'utf8');
    });
};

function readProcessedJSON(dir) {
  const processedPath = path.join(dir, 'processed');

  // read json data files to pass to handlebar template
  const deviceFile = path.join(processedPath, 'device.json');
  const appsFile = path.join(processedPath, 'apps.json');
  const pprofilesJSONFile = path.join(processedPath, 'pprofiles.json');
  const syslogJSONFile = path.join(processedPath, 'syslog.json');
  const crashreportsJSONFile = path.join(processedPath, 'crashreports.json');
  const backupJSONFile = path.join(processedPath, 'backup.json');

  const data = {};
  
  try {
    const deviceJSON = fs.readFileSync(deviceFile, 'utf8');
    const appsJSON = fs.readFileSync(appsFile, 'utf8');
    const pprofilesJSON = fs.readFileSync(pprofilesJSONFile, 'utf8');
    const syslogJSON = fs.readFileSync(syslogJSONFile, 'utf8');
    const crashreportsJSON = fs.readFileSync(crashreportsJSONFile, 'utf8');
    const backupJSON = fs.readFileSync(backupJSONFile, 'utf8');

    data.cli = pkg.name + ' v' + pkg.version;
    data.device = JSON.parse(deviceJSON);
    data.apps = JSON.parse(appsJSON);
    data.pprofiles = JSON.parse(pprofilesJSON);
    data.syslog = JSON.parse(syslogJSON);
    data.crashreports = JSON.parse(crashreportsJSON);
    data.backup = JSON.parse(backupJSON);
    return data;
  } catch (err) {
    logger.error(err);
    return data;
  }
}

function findIssues(dir, callback) {
  const data = readProcessedJSON(dir);
  const issues = {};
  issues.summary = {};
  issues.details = [];
  let issueCount = 0;

  
/*
  if (data.device.details.PasswordProtected === 'true') {
    count++;
    let issueDetails = {};
    issueDetails.title = 'Device not password protected';
    issueDetails.level = 'medium';
    issueDetails.description = 'This device does is not password protected. The device is more suseptible to compromise if an attacker can briefly gain physical access. THese risks include the ability to extract data from the device (using backup, forensic or maybe even ios-triage!) and run applications. In addition, sensitive data encrypted at rest by the iDevice and apps lack an additional level of security.';
    issueDetails.remediation = 'Password protext the device, ideally with an alphanumeric passcode or a PIN at least 6 digits long';
    issues.details.push(issueDetails);     
  }

  issues.summary.count = issueCount;
*/
  logger.info("data in findIssues: %s", JSON.stringify(data));
  logger.debug("findIssues complete, %s", JSON.stringify(issues));
  callback(null, "find issues completed");

}

function generateReport(dir, callback) {

  const processedPath = path.join(dir, 'processed');
  const artifactPath = path.join(dir, 'artifacts');
  const reportPath = path.join(dir,'reports');
  const cssPath = path.join(reportPath,'assets','dist','css');

  // if no artifact dir exists, err. 
  if (!fs.existsSync(artifactPath)) {
    return callback("No artifact directory found, run `ios-triage extract <dir>` first");
  } else {  
    // see if processed dir exists, if so alert but continue. otherwise, create
    if (!fs.existsSync(processedPath)) {
      return callback("No processed directory found, run `ios-triage process <dir>` first");
    } else {
      // create report dir and copy assests if needed
      if(!fs.existsSync(reportPath)) {
       fs.mkdirSync(reportPath);
      } 

      // copy assets to report dir if needed, assuming if css dir exists files were copied
      // a user could muck this up if they tinker in those dirs but punting for now
      if(!fs.existsSync(cssPath)) {
        const pkgAssetPath = path.join(__base, 'html', 'bootstrap4');
        copydir.sync(pkgAssetPath, reportPath);
      };

      const data = readProcessedJSON(dir);

      logger.debug(JSON.stringify(data));

      // register handlebarsjs partial files
      const partials = ["header", "topnavbar", "footer", "detailstabs"];
      partials.forEach(function (item) {
        let partialFile = __base + 'html/templates/partials/' + item + '.hbs';
        let partial = handlebars.compile(fs.readFileSync(partialFile, 'utf-8'));
        handlebars.registerPartial(item, partial);
      });

      // register helpers
      handlebars.registerHelper('toJSON', function(object){
          return new handlebars.SafeString(JSON.stringify(object));
      });

/*
      // async method bit me...tried to compile index template before partial
      // was complete. Moved to sync for now but could do async.series too
      fs.readFile(navbarPartialFile, 'utf-8', function(error, partial){
        const navbarPartial = handlebars.compile(partial);
        handlebars.registerPartial('navbarPartial', navbarPartial);
      });
*/

      // compile handlebarsjs templates, need to add diff json data files next
      const templateList = ["index", "issues", "diffs", "community", "apps", "device", "crashreports", "pprofiles", "artifacts"];
      templateList.forEach(function (templateName) {
        let templateFile = __base + 'html/templates/' + templateName + '.hbs';
        logger.debug("reading temple file: %s", templateFile);
        fs.readFile(templateFile, 'utf-8', function(error, source){
          logger.debug("source is type: %s", Object.prototype.toString.apply(source));
          const template = handlebars.compile(source);
          const html = template(data);
          // copy html to <dir>/reports/index.html
          const htmlFile = path.join(reportPath, templateName + '.html');
          fs.writeFile(htmlFile, html, 'utf8');
        });
      });


    callback(null, "report saved to " + path.resolve(path.join(reportPath, "index.html")));
    };
  };
};

