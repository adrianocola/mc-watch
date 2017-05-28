const _ = require('lodash');
const express = require('express');
const router = express.Router();
const path = require('path');
const favicon = require('serve-favicon');
const humanizeDuration = require('humanize-duration');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const async = require('async');
const moment = require('moment');
const request = require('request');
const low = require('lowdb');
const db = low('db.json');
db.defaults({ stats: [], startDurationAvg: 90 }).write();

const config = require('./config.json');

const AWS_STATUS_PENDING = 'pending';
const AWS_STATUS_RUNNING = 'running';
const AWS_STATUS_SHUTTING_DOWN = 'shutting-down';
const AWS_STATUS_TERMINATED = 'terminated';
const AWS_STATUS_STOPPING = 'stopping';
const AWS_STATUS_STOPPED = 'stopped';

const MC_STATUS_STOPPED = 'MC_STATUS_STOPPED';
const MC_STATUS_STARTED = 'MC_STATUS_STARTED';

let AWS_STATUS = AWS_STATUS_STOPPED;
let MC_STATUS = MC_STATUS_STOPPED;
let MC_EMPTY_COUNT = 0;

let startDate;
let stopDate;
let askedToStartDate;
let currentPlayers = [];
let leftPlayers = {};


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
    console.log('Minecraft Ping Error');
    console.log(error);
    cb(null);
  });
};

const mc = require('minecraft-protocol');
const mcServer = mc.createServer({
  'online-mode': false,   // optional
  encryption: true,      // optional
  host: '0.0.0.0',       // optional
  port: 25565,           // optional
  version: '1.11.2',
  beforePing: (response, client, cb) => {
    response.players.max = 0;
    if(AWS_STATUS !== AWS_STATUS_STOPPED){
      const perc = Math.floor(100 * (moment().diff(askedToStartDate, 'seconds')/db.get('startDurationAvg').value()));
      response.description.text = `§6STARTING§7 - Starting Server! §f${perc > 100 ? 100: perc}%`;
    }else{
      response.description.text = '§4OFFLINE§7 - Enter to start server!';
    }
    cb(null, response);
  }
});
mcServer.on('login', function(client, msg) {
  client.on('error', (err) => {
    console.log('MC client error: ');
    console.log(err);
  });
  if(AWS_STATUS !== AWS_STATUS_STOPPED){
    return client.end(`Already starting Server! Wait a few seconds! (±${db.get('startDurationAvg').value()}s)`);
  }

  instanceStart(() => {
    notify('Asked to start server via Minecraft. User: ' + client.username, true);
    client.end(`Starting Server! Wait a few seconds! (±${db.get('startDurationAvg').value()}s)`);
  });
});
console.log('Started MC Server listener on port 25565');

/*******************
 *  STATUS
 *******************/

const getPlayersStatus = (cb) => {

  if(MC_STATUS !== MC_STATUS_STARTED){
    return cb(null, db.get('stats').value());
  }

  request('http://' + config.MC_SERVER_ADDRESS + ':' + config.MC_STATS_PORT, (err, response, body) => {
    if(err) return cb(null, db.get('stats').value());

    const stats = JSON.parse(body);

    db.set('stats', stats).write();

    cb(null, stats);
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
    askedToStartDate = moment();
    MC_EMPTY_COUNT = 0;
    checkInstanceStatus();
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
    if (err) return console.log(err);
    setAWSStatus(data.Name);
  });
};

// check if MC is empty
const checkMinecraftStatus = () => {
  if(AWS_STATUS === AWS_STATUS_RUNNING){
    minecraftStatus((err, mcStatus) => {
      if(err || !mcStatus){
        currentPlayers = [];
        MC_EMPTY_COUNT = 0;
        return;
      }

      const statusPlayers = _.map(mcStatus.players, 'name');
      const allPlayers = _.union(currentPlayers, statusPlayers);

      const joined = _.difference(statusPlayers, currentPlayers);
      const left = _.difference(currentPlayers, statusPlayers);
      const playersInfo = '. Jogadores online: ' + ( statusPlayers.length ? statusPlayers.join(', ') : 'ninguém =(');

      _.each(joined, (player) => {
        // only notify if player didn't left recently
        if(leftPlayers[player]){
          clearTimeout(leftPlayers[player]);
          delete leftPlayers[player];
          return;
        }
        notify('Jogador entrou: ' + player + playersInfo, false, allPlayers);
      });

      _.each(left, (player) => {
        // clear previous schedules left (if have one)
        if(leftPlayers[player]){
          clearTimeout(leftPlayers[player]);
          delete leftPlayers[player];
        }
        // schedule to notify that a player left only after some time
        // (to prevent notifications of disconnects followed by a fast reconnect)
        leftPlayers[player] = setTimeout(() => {
          notify('Jogador pipocou: ' + player + playersInfo, false, allPlayers);
          delete leftPlayers[player];
        }, 60*1000);
      });

      currentPlayers = statusPlayers;

      setMCStatus(MC_STATUS_STARTED);
      if(statusPlayers.length){
        if(MC_EMPTY_COUNT){
          console.log('Server is not empty anymore!');
        }
        MC_EMPTY_COUNT = 0;

        return;
      }

      if(!MC_EMPTY_COUNT){
        currentPlayers = [];
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
setInterval(checkInstanceStatus, 20 * 1000);
checkInstanceStatus();

/*******************
 *  FLOW
 *******************/

const setAWSStatus = (newStatus) => {
  if(newStatus !== AWS_STATUS) {
    console.log('Instance changed to: ' + newStatus);

    if (AWS_STATUS !== AWS_STATUS_RUNNING && newStatus === AWS_STATUS_RUNNING) {
      //changed to running, must update DNS
      console.log('Instance is now running, must update DNS IP');

      instanceIp((err, ip) => {
        if (err || !ip) return console.log(err || 'Instance don\'t have IP');
        console.log('Instance IP is: ' + ip);
        updateZone(ip, (err, resp) => {
          if (err) return console.log(err);
          console.log('Updated DNS to IP: ' + ip);
        });
      });
    } else if (AWS_STATUS !== AWS_STATUS_STOPPED && newStatus === AWS_STATUS_STOPPED) {
      setMCStatus(MC_STATUS_STOPPED);
      //changed to stopped, must update DNS IP back to mc-watch
      console.log('Instance is now stopped, must update DNS IP');

      updateZone(config.MC_WATCH_SERVER_IP, (err, resp) => {
        if (err) return console.log(err);
        console.log('Updated DNS to MC-WATCH IP');
      });
    }
  }

  AWS_STATUS = newStatus;
};

const setMCStatus = (newStatus) => {

  if(newStatus !== MC_STATUS) {
    console.log('Minecraft changed to: ' + newStatus);

    if (MC_STATUS !== MC_STATUS_STARTED && newStatus === MC_STATUS_STARTED) {
      startDate = moment();
      const startDuration = moment().diff(askedToStartDate, 'seconds');
      db.set('startDurationAvg', (Math.floor((db.get('startDurationAvg').value() + startDuration)/2) || 90) + 30).white();
      notify(`MC server started (in ${startDuration} seconds)`, true);
    } else if (MC_STATUS !== MC_STATUS_STOPPED && newStatus === MC_STATUS_STOPPED) {
      stopDate = moment();
      const runDuration = stopDate.diff(startDate, 'minutes');
      notify(`MC server stop (was online for ${runDuration} minutes)`, true);
    }
  }

  MC_STATUS = newStatus;
};

/*******************
 *  NOTIFY
 *******************/

const notify = (msg, adminOnly, exclude) => {
  console.log(msg);
  config.NOTIFICATIONS.forEach((notif) => {
    if(adminOnly && !notif.admin) return;
    if(!_.isEmpty(exclude) && _.includes(exclude, notif.player)) return;
    console.log('Notifying player ' + notif.player);

    if(notif.type === 'PUSH_ME'){
      request.post('https://pushmeapi.jagcesar.se').form({token: notif.token, title: msg});
    }else if(notif.type === 'NMA'){
      request.post('https://www.notifymyandroid.com/publicapi/notify').form({apikey: notif.token, application: 'mc-watch', event: 'mc.adrianocola.com', description: msg});
    }
  });
};

/*******************
 *  APP
 *******************/

const app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// uncomment after placing your favicon in /public
//app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
// app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

router.get('/', (req, res, next) => {
  async.parallel([
    instanceStatus,
    minecraftStatus,
    getPlayersStatus,
  ], (err, results) => {
    if(err) {
      console.log(err);
      return next(err);
    }
    res.render('index', {_, humanizeDuration, awsStatus: results[0], mcStatus: results[1], playersStatus: results[2], count: Math.floor(MC_EMPTY_COUNT/6)});
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
