#!/usr/bin/env node
'use strict';

var program = require('commander');
var fs = require('fs');
var os = require('os');
var xml2js = require('xml2js');
var async = require('async');

const child_process = require('child_process');

program
  .version('0.1.0')
  .description('Incident response tool for iPhone or iPad')
  .option('-o, --output [directory]', 'Set output directory')
  .option('-v, --verbose', 'Display verbose output')

program
  .command('collect')
  .description('Collect IR artifacts from iPhone or iPad')
  .option('-b, --backup', 'Backup iOS device')
  .option('--syslog-timeout <ms>', 'Optional timeout for how long to collect syslong, e.g. 86400 to collect for a day')
  .action(function(options) {
      collectArtifacts(options);
  });

program
  .command('process')
  .description('Process collected artifacts')
  .action(function() {
    processArtifacts();
  });

program
  .command('report')
  .description('Generate iOS IR report')
  .action(function() {
    generateReport();
  });

program.parse(process.argv);

// if program was called with no arguments, show help.
if (program.args.length === 0) program.help();

function setWorkingDirectory (userOutputDir, udid, currentEpoch) {
  let wd = ""
  if (userOutputDir) {
    wd = userOutputDir;
  } else {
    wd = __dirname;
  }

  // need to move away from "/" and start using path.sep
  const wd_udid = wd + "/" + udid;
  const wd_udid_epoch = wd_udid + '/' + currentEpoch;

  if (!fs.existsSync(wd_udid)){
    fs.mkdirSync(wd_udid);
  }

  if (!fs.existsSync(wd_udid_epoch)){
    fs.mkdirSync(wd_udid_epoch);
  }

  if (!fs.existsSync(wd_udid_epoch + '/artifacts')){
    fs.mkdirSync(wd_udid_epoch + '/artifacts');
  }

  console.log("working directory set to " + wd_udid_epoch);
  return(wd_udid_epoch);
}

function collectArtifacts(options) {
  // let's first get the UDID...if we can't do this successfully, we have a problem 
  getUDID(function (error, udid) {
    if (error) { return console.error(error); }

    // no error getting UDID so time to fetch data
    // first we'll setup the working directory, saving data in unique dir each time based on epoch time
    const currentEpoch = new Date().getTime(); 
    const wd = setWorkingDirectory(program.output, udid, currentEpoch);

    const idevicesyslog = getDeviceSyslog(udid, wd, options.syslogTimeout); 

    async.parallel({
      backup: function(callback) {
        if (options.backup) {
          doDeviceBackup(udid, wd, callback);
        } else {
          console.log("Skipping device backup");
          // this callback() iw critical so async.parallel can returm
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
        listProvisioningProfiles(udid, wd, callback);
      },
      crashReports: function(callback) {
        getCrashReports(udid, wd, callback);
      }
    }, function(err, results) {
      //handle any errors from extraction functions
      if(options.syslogTimeout === undefined) {
        console.log("completed all extraction functions so we'll now kill deviceSyslog");
        idevicesyslog.kill('SIGINT');
      } else {
        console.log("waiting " + options.syslogTimeout + "ms for syslog to execute");
      };
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
      console.log("Authorized iDevice found, UDID: " + udid_str.trim());
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
    userTimeout = Number(syslogTimeout);
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

  console.log("capturing device syslog...");

  // on data events, write chunks to file
  idevicesyslog.stdout.on('data', (chunk) => { 
    file.write(chunk); 
  });

  // after Stream ends, close the file, inform user of saved file
  idevicesyslog.stdout.on('end', () => { 
    file.end(); 
    console.log("in getDeviceSyslog, end event fired");
  });

  idevicesyslog.on('close', function(code) {
    if (code != 0) {
      console.error("idevicesyslog returned error code " + code);
      // return callback(new Error('idevicesyslog returned error code ' + code));
    } else {
      console.log("in getDeviceSyslog, close event triggered without error");
      console.log('iOS Device syslog saved');
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

  const file_name = 'ideviceinfo.txt';
  const file = fs.createWriteStream(wd + '/artifacts/' + file_name);

  // call ideviceinfo binary
  const ideviceinfo = child_process.spawn('ideviceinfo', []);

  // on data events, write chunks to file
  ideviceinfo.stdout.on('data', (chunk) => { 
    file.write(chunk); 
  });

  // after Stream ends, close the file, inform user of saved file
  ideviceinfo.stdout.on('end', () => { 
    file.end(); 
    console.log('iOS Device info saved');
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
    console.log('iOS Device installed apps saved');
    callback(null, ideviceinstaller);
  });

  ideviceinstaller.on('close', function(code) {
    if (code != 0) {
      callback(new Error('ideviceinstaller returned error code ' + code));
    }
  });
};

function listProvisioningProfiles(udid, wd, callback) { 

  const file_name = 'provisioning-profiles.txt';
  const file = fs.createWriteStream(wd + '/artifacts/' + file_name);

  // call ideviceprovision binary
  const ideviceprovision = child_process.spawn('ideviceprovision', ['list']);

  // on data events, write chunks to file
  ideviceprovision.stdout.on('data', (chunk) => { 
    file.write(chunk); 
  });

  // after Stream ends, close the file, inform user of saved file
  ideviceprovision.stdout.on('end', () => { 
    file.end(); 
    console.log('Installed provisioning profiles saved');
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
    console.log('Crash reports and log saved');
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
    console.log('Device backup and log saved');
    callback(null, idevicebackup2);
  });

  idevicebackup2.on('close', function(code) {
    if (code != 0) {
      callback(new Error('idevicebackup2 returned error code ' + code));
    }
  });
};

function processArtifacts () {
  console.log("process artifacts");
}

function generateReport () {
  //console.log("generate report");
  var parser = new xml2js.Parser();
  fs.readFile(wd + '/artifacts/installed-apps.xml', function(err, data) {
    parser.parseString(data, function (err, result) {
      console.dir(JSON.stringify(result));
    });
  });

}

