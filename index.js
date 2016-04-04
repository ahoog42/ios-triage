#!/usr/bin/env node
'use strict';

var program = require('commander');
var fs = require('fs');
var os = require('os');

const spawn = require('child_process').spawn;
var wd = '/Users/hiro/Desktop/ios-triage/993aa52471a3e6ea117eb619927d74f3aa7511bf';

program
  .version('0.1.0')
  .description('Incident response tool for iPhone or iPad')
  .option('-o, --output [directory]', 'Set output [directory]')
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

function collectArtifacts () {
  var deviceInfo = getDeviceInfo();
  //getDeviceInfo(function printToScreen(error, data) {
  //  if (error) return console.error(error);
  //  console.log('[ ' + data.toString() + ']');
  //});
}

function getDeviceInfo () { 

  var file_name = 'ideviceinfo.txt';
  var file = fs.createWriteStream(wd + '/artifacts/' + file_name);

  // call ideviceinfo binary
  var ideviceinfo = spawn('ideviceinfo', []);

  // on data events, write chunks to file
  ideviceinfo.stdout.on('data', (chunk) => { 
    file.write(chunk); 
  });

  // after Stream ends, close the file, inform user of saved file
  ideviceinfo.stdout.on('end', () => { 
    file.end(); 
    console.log('iOS Device info saved to: ' + wd + '/artifacts/' + file_name);
  });

  // should this event be on exit or on close?
  // per documentation, not all Streams emit a close event
  // https://nodejs.org/api/stream.html#stream_event_close
  ideviceinfo.on('close', function(code) {
    if (code != 0) {
      console.error('ideviceinfo returned error code ' + code);
    }
  });
};

function processArtifacts () {
  console.log("process artifacts");
}

function generateReport () {
  console.log("generate report");
}

