const express = require('express');
const router = express.Router();
const path = require('path');
const favicon = require('serve-favicon');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const async = require('async');

const config = require('./config.json');

const AWS_STATUS_PENDING = 'pending';
const AWS_STATUS_RUNNING = 'running';
const AWS_STATUS_SHUTTING_DOWN = 'shutting-down';
const AWS_STATUS_TERMINATED = 'terminated';
const AWS_STATUS_STOPPING = 'stopping';
const AWS_STATUS_STOPPED = 'stopped';

let AWS_STATUS = AWS_STATUS_STOPPED;
let MC_EMPTY_COUNT = 0;


/*******************
 *  MINECRAFT
 *******************/

const minecraftStatus = (cb) => {
  const Gamedig = require('gamedig');
  Gamedig.query({
    type: 'minecraftping',
    host: config.MC_SERVER_ADDRESS,
  }).then((state) => {
    cb(null, state);
  }).catch((error) => {
    cb(error);
  });
};

/*******************
 *  AWS
 *******************/

const AWS = require('aws-sdk');

AWS.config.update({
  accessKeyId: config.AWS_KEY,
  secretAccessKey: config.AWS_SECRET,
  region: config.AWS_REGION,
});
const ec2 = new AWS.EC2();

const instanceIp = (cb) => {
  ec2.describeInstances({InstanceIds: [config.AWS_INSTANCE_ID]}, (err, data)=> {
    if (err || !data.Reservations.length) return cb(err); // an error occurred
    cb(null, data.Reservations[0].Instances[0].PublicIpAddress);           // successful response
  });
};

const instanceStatus = (cb) => {
  ec2.describeInstances({InstanceIds: [config.AWS_INSTANCE_ID]}, (err, data)=> {
    if (err) return cb(err, {Name: AWS_STATUS_STOPPED}); // an error occurred
    cb(null, data.Reservations[0].Instances[0].State);           // successful response
  });
};

const instanceStop = (cb) => {
  ec2.stopInstances({InstanceIds: [config.AWS_INSTANCE_ID]}, function(err, data) {
    if (err) return cb(err); // an error occurred
    cb(null, data);           // successful response
  });
};

const instanceStart = (cb) => {
  ec2.startInstances({InstanceIds: [config.AWS_INSTANCE_ID]}, function(err, data) {
    if (err) return cb(err); // an error occurred
    cb(null, data);           // successful response
  });
};

/*******************
 *  DNS
 *******************/

const dnsClient = require('dnsimple')({
  accessToken: config.DNSIMPLE_TOKEN,
});

const updateZone = (ip, cb) => {
  dnsClient.zones.updateZoneRecord(config.DNSIMPLE_ACCOUNT_ID, config.DNSIMPLE_ZONE_ID, config.DNSIMPLE_RECORD_ID, {content: ip}).then((data) => cb(null, data),cb);
};

/*******************
 *  WATCH
 *******************/

// verify instance status
const checkInstanceStatus = () => {
  instanceIp(() => {});
  instanceStatus((err, data) => {
    if(err) return console.log(err);
    const newStatus = data.Name;
    if(newStatus !== AWS_STATUS){
      console.log('Instance changed to: ' + newStatus);

      if(AWS_STATUS !== AWS_STATUS_RUNNING && newStatus === AWS_STATUS_RUNNING){
        //changed to running, must update DNS
        console.log('Instance is now running, must update DNS IP');

        instanceIp((err, ip) => {
          if(err || !ip) return console.log(err || 'Instance don\'t have IP');
          console.log('Instance IP is: ' + ip);
          updateZone(ip, (err, resp) => {
            if(err) return console.log(err);
            console.log('Updated DNS to IP: ' + ip);
          });
        });
      }

      AWS_STATUS = newStatus;
    }
  })
};

// check if MC is empty
const checkMinecraftStatus = () => {
  if(AWS_STATUS === AWS_STATUS_RUNNING){
    minecraftStatus((err, mcStatus) => {
      if(err || !mcStatus || mcStatus.players.length){
        if(MC_EMPTY_COUNT){
          console.log('Server is not empty anymore!');
        }
        MC_EMPTY_COUNT = 0;
        return;
      }

      if(!MC_EMPTY_COUNT){
        console.log('Server is empty!');
      }

      MC_EMPTY_COUNT += 1;

      if(MC_EMPTY_COUNT >= 60){
        console.log('Shutting down instance because server is empty');
        instanceStop(() => {
          checkInstanceStatus();
        });
      }
    })
  }
};

setInterval(checkMinecraftStatus, 10 * 1000);
setInterval(checkInstanceStatus, 60 * 1000);
checkInstanceStatus();

/*******************
 *  APP
 *******************/

const app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// uncomment after placing your favicon in /public
//app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

router.get('/', (req, res, next) => {
  async.parallel([
    instanceStatus,
    minecraftStatus,
  ], (err, results) => {
    res.render('index', {awsStatus: results[0], mcStatus: results[1], count: Math.floor(MC_EMPTY_COUNT/6)});
  })
});
router.post('/', (req, res, next) => {
  console.log('Starting instance...');
  instanceStart(() => {
    res.redirect('/');
  });
});

app.use('/', router);

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// error handler
app.use(function (err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
