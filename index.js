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
  .action(collectArtifacts);

program
  .command('process')
  .description('Process collected artifacts')
  .action(processArtifacts);

program
  .command('report')
  .description('Generate iOS IR report')
  .action(generateReport);

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

function collectArtifacts () {
  // let's first get the UDID...if we can't do this successfully, we have a problem 
  getUDID(function (error, udid) {
    if (error) { return console.error(error); }

    // no error getting UDID so time to fetch data
    // first we'll setup the working directory, saving data in unique dir each time based on epoch time
    const currentEpoch = new Date().getTime(); 
    const wd = setWorkingDirectory(program.output, udid, currentEpoch);

    async.parallel({
      syslog: function(callback) {
        getDeviceSyslog(udid, wd, callback);
      },
      deviceInfo: function(callback) {
        getDeviceInfo(udid, wd, callback);
      },
      installedApps: function(callback) {
        getInstalledApps(udid, wd, callback);
      },
      provisioningProfiles: function(callback) {
        listProvisioningProfiles(udid, wd, callback);
      }
    }, function(err, results) {
      //handle any errors from extraction functions
      console.log("completed all extraction functions so we'd now kill deviceSyslog");
      results.syslog.kill('SIGINT');
    }); 
 
    // idevicebackup2 backup --full . (make backup dir)
    // idevicecrashreport -e -k . 

      // going to try nesting all other data extraction functions in getDeviceData
      // when all of those return, then we can call deviceSyslog.kill();
      // if (error) { return console.error("error in getDeviceData cb: " + error); }
      // console.log("all sub data extraction complete so kill syslog");
      // deviceSyslog.kill();
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

function getDeviceSyslog(udid, wd, callback) { 

  const file_name = 'syslog.txt';
  const file = fs.createWriteStream(wd + '/artifacts/' + file_name);

  // call idevicesyslog binary
  // currently I hard coded 10 seconds for idevicesyslog but in future would prefer
  // the default is to exit after all data collection is done or allow user to
  // specify a timeout so they could run syslog for, say, a day to profile a device 
  const syslogTimeout = 10000;
  const idevicesyslog = child_process.execFile('idevicesyslog', [], { timeout: syslogTimeout });

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
      console.log('iOS Device syslog saved to: ' + file.path);
    }
  });

  // for syslog, we call back immediately and return the childProcess so the calling program
  // has control over deciding when to kill the process. Could be immediately after other
  // extraction is complete or after a timeout value
  callback(null, idevicesyslog);
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
    console.log('iOS Device info saved to: ' + file.path);
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
    console.log('iOS Device installed apps saved to: ' + file.path);
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
    console.log('Installed provisioning profiles saved to: ' + file.path);
    callback(null, ideviceprovision);
  });

  ideviceprovision.on('close', function(code) {
    if (code != 0) {
      callback(new Error('ideviceprovision returned error code ' + code));
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

