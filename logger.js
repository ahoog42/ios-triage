'use strict';

const winston = require('winston');
const tsFormat = () => (new Date()).toLocaleTimeString();

let logger = winston.createLogger({ 
  transports: [
    // colorize the output to the console
    new (winston.transports.Console)({
      timestamp: tsFormat,
      colorize: true,
      level: 'info'
    }),
  ],
  exitOnError: false
});

module.exports = logger;
