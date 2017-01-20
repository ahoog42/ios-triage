'use strict';

const winston = require('winston');
const tsFormat = () => (new Date()).toLocaleTimeString();

const logger = new (winston.Logger)({
  transports: [
    // colorize the output to the console
    new (winston.transports.Console)({
      timestamp: tsFormat,
      colorize: true,
      level: 'info'
    })
// will add later when i figure out how to either update filename from calling js
//    new (winston.transports.File)({
//      filename: 'debug.log',
//      timestamp: tsFormat,
//      level: 'debug'
//    })
  ]
});

module.exports = logger
