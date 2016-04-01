#!/usr/bin/env node
'use strict';

var program = require('commander');
const spawn = require('child_process').spawn;
//const ideviceinfo = spawn('ideviceinfo', []);


program
  .version('0.1.0')
  .command('collect')
  .description('Collect IR artifacts from iPhone or iPad')
  .option('-v, --verbose', 'Display verbose output')
  .action(function() {
    var ideviceinfo = spawn('ideviceinfo', []);

    ideviceinfo.stdout.on('data', (data) => {
      console.log(`stdout: ${data}`);
    });

    ideviceinfo.stderr.on('data', (data) => {
      console.log(`stderr: ${data}`);
    });

    ideviceinfo.on('close', (code) => {
      console.log(`child process exited with code ${code}`);
    });
});

program.parse(process.argv);

console.log('Hello, world!');

