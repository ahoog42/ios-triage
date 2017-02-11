# ios-triage
Node.js cli for iOS incident response. Program will extract, process and report (including diffs) on iOS device and app telemetry.

## Installation
Currently working on OSX and Linux. This program depends on the excellent libimobiledevice project.

### OSX install

### Linux install
These instructions are based on a fresh Ubuntu 16.04 LTS install.

Install dependecies:

```
sudo apt-get install ideviceinstaller libimobiledevice-utils build-essential libssl-dev git
```

Install node ([nvm](https://github.com/creationix/nvm))
```
curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.0/install.sh | bash

export NVM_DIR="/home/hiro/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

nvm install node
nvm use node
```


## Usage

## Future work

## Contribute
