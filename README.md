# ios-triage
Node.js cli for iOS incident response. Program will extract, process and report (including diffs) on iOS device and app telemetry.

## Installation
Currently working on OSX and Linux. This program depends on the excellent libimobiledevice project.

### OS specific steps

#### OSX
Make sure brew is installed. Then, install libimobiledevice from `--HEAD` otherwise I had problems connecting to lockdownd (as of Dec 2016):

```
brew install --HEAD libimobiledevice
brew install --HEAD ideviceinstaller
```

#### Linux (Ubuntu)
These instructions are based on a fresh Ubuntu 16.04 LTS install.

```
sudo apt-get install ideviceinstaller libimobiledevice-utils build-essential libssl-dev git
```

### Install node ([nvm](https://github.com/creationix/nvm))
```
curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.0/install.sh | bash

export NVM_DIR="/home/hiro/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

nvm install node
nvm use node
```

### Clone ios-triage, install and link

```
git clone git@github.com:ahoog42/ios-triage.git

cd ios-install
npm install
npm link
```

## Usage
When you run ios-triage, there are three primary steps:

1. extract
1. process
1. report

Each command has various options. You can run `ios-triage <cmd> --help` for additional instructions. Below are examples of the most common options and workflow.

### extract
ios-triage will automatically create a directory with the device UDID and then a timestamp (epoch in ms) for each extraction. This allows you to collect telemetry over time and perform diffs. A good example would be if an individual is travelling overseas and might be a targeted. You could image the device prior to the trip and after to then compare the available device telemetry.

**Note:** you must connect the iDevice to your host and trust it from the device. Then, run the following:

`ios-triage extract .`

### process
To process the device extraction, you have to point ios-triage at the top-level extraction directory structure is <udid>/<epoch>. An example would be:

`$ ios-triage process dc9363415e5fbf18ea8277986f3b693cf01827aa/1486829681725/`

### report
To produce an analyst report, you simple direct ios-triage at the top-level extraction directory:

`$ ios-triage report dc9363415e5fbf18ea8277986f3b693cf01827aa/1486829681725/`

#### diffs
If you have two extractions that you've already processed, you can include a second directory to the report command which will then populate the Diff page with a comparision of what has changed between the two extractions:

```
cd dc9363415e5fbf18ea8277986f3b693cf01827aa
ios-triage report 1485283295826/ 1486829681725/ 
```

## Future work
There's quite a bit to do in the future. Also note that I used this project to teach myself nodejs so there's quite a bit of cruft in the code. 

* Move to a database backend
* Download iOS apps via iTunes and perform additional static analysis
* Integrate third-party data sources
* Allow upload and then comparision of non-PII data to crowsource our efforts

## Contribute
If you'd like to contribute to ios-triage, there are many ways to help:

* Run the tool, file big reports, suggestions, etc.
* Share non-PII data for comparitive analysis
* UX help!!
* Development of new features
* Documentation
