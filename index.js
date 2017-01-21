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
    processArtifacts(dir, function(err, runStatus) {
      if (err) { 
        logger.error(err); 
      } else {
        logger.info(runStatus);
      };
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

  const file_name = 'ideviceinfo.xml';
  const file = fs.createWriteStream(wd + '/artifacts/' + file_name);

  // call ideviceinfo binary
  const ideviceinfo = child_process.spawn('ideviceinfo', ['--xml']);

  // on data events, write chunks to file
  ideviceinfo.stdout.on('data', (chunk) => { 
    file.write(chunk); 
  });

  // after Stream ends, close the file, inform user of saved file
  ideviceinfo.stdout.on('end', () => { 
    file.end(); 
    logger.info('iOS Device info saved');
    callback(null, ideviceinfo);
  });

  // should this event be on exit or on close?
  // per documentation, not all Streams emit a close event
  // https://nodejs.org/api/stream.html#stream_event_close
  ideviceinfo.on('close', function(code) {
    if (code != 0) {
      return callback(new Error('Error: ideviceinfo returned error code ' + code));
    }
  });
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
  const wd_pprofiles = wd + '/artifacts/pprofiles/';
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
      callback(new Error('idevicecrashreport returned error code ' + code));
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
      console.warn('Processed path already exists, overwriting previous processed data');
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

  };
};

function processInstalledAppsXML(dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const installedAppsXML = artifactPath + path.sep + 'installed-apps.xml';

  // try to open the installedApps.xml file, otherwise return error 
  fs.stat(installedAppsXML, function(err, stat) {
    if(err) {
      return callback(new Error("Installed apps not processed: " + err));
    } else {

  // read and parse plist file
  // TODO: error check the call to plist.parse
  const obj = plist.parse(fs.readFileSync(installedAppsXML, 'utf8'));

  // for further analysis
  const installedAppsDetailed = obj;

  // setup object to stored parsed app properties into
  const installedAppsParsed = {};
  installedAppsParsed.summary = {};
  installedAppsParsed.apps = [];

  // counters for summary app data
  let totalApps = 0;
  let userApps = 0;
  let systemApps = 0;
  let nonAppleSigner = 0;

  for (let prop in obj) {
    // every prop in array is properties for an app
    const app = obj[prop];
    let appInfo = {}; //object to store individual app properties in

    totalApps++;
    for(let attrib in app) {
      switch(attrib) {
        case "CFBundleName":
          appInfo.name = app[attrib];
          break;
        case "CFBundleVersion":
          appInfo.version = app[attrib];
          break;
        case "CFBundleIdentifier":
          appInfo.bundleIdentifier = app[attrib];
          break;
        case "SignerIdentity":
          appInfo.signerIdentity = app[attrib];
          if(app[attrib] !== "Apple iPhone OS Application Signing") {
            nonAppleSigner++;
          }
          break;
        case "ApplicationType":
          appInfo.applicationType = app[attrib];
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
    // push current appInfo into installedAppsParsed.apps array
    installedAppsParsed.apps.push(appInfo);
    // logger.debug("moving to next app");
  };

  // object for summary app data
  installedAppsParsed.summary = {
    "totalApps": totalApps,
    "userApps": userApps,
    "systemApps": systemApps,
    "nonAppleSigner": nonAppleSigner
  };

  logger.info("installed apps xml processed, writing to disk");
  const parsedAppsJSON = JSON.stringify(installedAppsParsed);
  const detailedAppsJSON = JSON.stringify(installedAppsDetailed);
  // FIXME should catch errors, maye use callbacks?
  fs.writeFile(processedPath + path.sep + 'installedApps.json', parsedAppsJSON, 'utf8');
  fs.writeFile(processedPath + path.sep + 'installedApps-Detailed.json', detailedAppsJSON, 'utf8');

  callback(null, "processed app data"); 
    };
  }); 
};

function processDeviceInfo(dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const deviceInfoXML = artifactPath + path.sep + 'ideviceinfo.xml';

  fs.stat(deviceInfoXML, function(err, stat) {
    if(err) {
      return callback(new Error("Installed apps not processed: " + err));
    } else {
      // read and parse plist file
      // TODO: error check the call to plist.parse
      const obj = plist.parse(fs.readFileSync(deviceInfoXML, 'utf8'));

      // for further analysis
      const deviceInfoAll = obj;

      // obj for summary data
      const deviceInfo = {};
      deviceInfo.summary = {
        "BasebandVersion": deviceInfoAll.BasebandVersion,
        "DeviceClass": deviceInfoAll.DeviceClass,
        "DeviceColor": deviceInfoAll.DeviceColor,
        "DeviceName": deviceInfoAll.DeviceName,
        "ModelNumber": deviceInfoAll.ModelNumber,
        "PasswordProtected": deviceInfoAll.PasswordProtected,
        "PhoneNumber": deviceInfoAll.PhoneNumber,
        "ProductType": deviceInfoAll.ProductType,
        "ProductVersion": deviceInfoAll.ProductVersion,
        "SerialNumber": deviceInfoAll.SerialNumber,
        "TimeZone": deviceInfoAll.TimeZone,
        "TrustedHostAttached": deviceInfoAll.TrustedHostAttached,
        "UniqueDeviceID": deviceInfoAll.UniqueDeviceID
      };

      logger.info("device info xml processed, writing to %s", processedPath + path.sep + 'deviceInfo.json');
      const deviceInfoJSON = JSON.stringify(deviceInfo);
      const allDeviceInfoJSON = JSON.stringify(deviceInfoAll);
      // FIXME should catch errors, maye use callbacks?
      fs.writeFile(processedPath + path.sep + 'deviceInfo.json', deviceInfoJSON, 'utf8');
      fs.writeFile(processedPath + path.sep + 'deviceInfo-All.json', allDeviceInfoJSON, 'utf8');
    };
    callback(null,"processed device info");
  });
};
  
function processProvisioningProfiles(dir, callback) {
  const artifactPath = path.join(dir, 'artifacts');
  const processedPath = path.join(dir, 'processed');
  const ideviceprovisionLog = artifactPath + path.sep + '/pprofiles/ideviceprovision.log';

  try {
    const pprofilesLog = fs.readFileSync(ideviceprovisionLog);
    const lines = pprofilesLog.toString().split('\n');
    const firstLine = lines[0];
    // the first line of this file "always" contains the following:
    // Device has 6 provisioning profiles installed:
    // let's split on " " and grab the 3rd items. Can you say fragile?!
    const words = firstLine.split(' ');
    const pprofilesFound = words[2];
    logger.debug("pprofiles found: %s", pprofilesFound);

    const pprofiles = {};
    pprofiles.summary = {
      "pprofilesFound": pprofilesFound
    }

    logger.info("pprofiles processed, writing to %s", processedPath + path.sep + 'pprofiles.json');
    const pprofilesJSON = JSON.stringify(pprofiles);
    // FIXME should catch errors, maye use callbacks?
    fs.writeFile(processedPath + path.sep + 'pprofiles.json', pprofilesJSON, 'utf8');
    callback(null,"processed pprofiles");
  } catch(err) {
      return callback(new Error("Provisioning profiles data not processed: " + err));
  };
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
    let count = 1;
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
        logger.info("crash report data processed, writing to %s", path.join(processedPath, 'crashreports.json'));
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

      // copy assets if needed, assuming if css dir exists files were copied
      // a user could muck this up if they tinker in those dirs but punting for now
      if(!fs.existsSync(cssPath)) {
        const pkgAssetPath = path.join(__base, 'html', 'bootstrap4');
        copydir.sync(pkgAssetPath, reportPath);
      };

      // read json data files to pass to handlebar template
      const deviceJSONFile = path.join(processedPath, 'deviceInfo.json');
      const appsJSONFile = path.join(processedPath, 'installedApps.json');
      const pprofilesJSONFile = path.join(processedPath, 'pprofiles.json');
      const syslogJSONFile = path.join(processedPath, 'syslog.json');
      const crashreportsJSONFile = path.join(processedPath, 'crashreports.json');

      const deviceJSON = fs.readFileSync(deviceJSONFile, 'utf8');
      const appsJSON = fs.readFileSync(appsJSONFile, 'utf8');
      const pprofilesJSON = fs.readFileSync(pprofilesJSONFile, 'utf8');
      const syslogJSON = fs.readFileSync(syslogJSONFile, 'utf8');
      const crashreportsJSON = fs.readFileSync(crashreportsJSONFile, 'utf8');

      const data = {};
      data.cli = pkg.name + ' v' + pkg.version;
      data.device = JSON.parse(deviceJSON);
      data.apps = JSON.parse(appsJSON);
      data.pprofiles = JSON.parse(pprofilesJSON);
      data.syslog = JSON.parse(syslogJSON);
      data.crashreports = JSON.parse(crashreportsJSON);

      logger.debug(JSON.stringify(data));

      const headerPartialFile = __base + 'html/templates/partials/header.hbs';
      const headerPartial = handlebars.compile(fs.readFileSync(headerPartialFile, 'utf-8'));
      handlebars.registerPartial('headerPartial', headerPartial);

      const topnavbarPartialFile = __base + 'html/templates/partials/topnavbar.hbs';
      const topnavbarPartial = handlebars.compile(fs.readFileSync(topnavbarPartialFile, 'utf-8'));
      handlebars.registerPartial('topnavbarPartial', topnavbarPartial);

      const footerPartialFile = __base + 'html/templates/partials/footer.hbs';
      const footerPartial = handlebars.compile(fs.readFileSync(footerPartialFile, 'utf-8'));
      handlebars.registerPartial('footerPartial', footerPartial);

/*
      // async method bit me...tried to compile index template before partial
      // was complete. Moved to sync for now but could do async.series too
      fs.readFile(navbarPartialFile, 'utf-8', function(error, partial){
        const navbarPartial = handlebars.compile(partial);
        handlebars.registerPartial('navbarPartial', navbarPartial);
      });
*/

      const templateFile = __base + 'html/templates/index.hbs';
      fs.readFile(templateFile, 'utf-8', function(error, source){
        const template = handlebars.compile(source);
        const html = template(data);
        // copy html to <dir>/reports/index.html
        const indexHTML = path.join(reportPath,'index.html');
        fs.writeFile(indexHTML, html, 'utf8');
        logger.info('Reports written to %s', indexHTML);
      });
    callback(null, "report generated");
    };
  };
};

