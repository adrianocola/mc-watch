/**
 * Created by adriano on 27/05/17.
 */

const http = require('http');
const fs = require('fs');
const nbt = require('prismarine-nbt');
const async = require('async');

const STATSDIR = '/home/ec2-user/server/world/stats';
const PLAYERDIR = '/home/ec2-user/server/world/playerdata';

const app = http.createServer(function(req,res){
  fs.readdir(STATSDIR, (err, files) => {
    res.setHeader('Content-Type', 'application/json');

    async.map(files, (fileName, cb) => {
      const uuid = fileName.replace('\.json','');
      const playerDat = fs.readFileSync(PLAYERDIR + '/' + uuid + '.dat');
      nbt.parse(playerDat, function(error, data) {
        const player = data.value.bukkit.value.lastKnownName.value;
        cb(null, {
          uuid,
          player,
          stats: JSON.parse(fs.readFileSync(STATSDIR + '/' + fileName, 'utf8')),
        });
      });
    }, (err, stats) => {
      res.end(JSON.stringify(stats));
    });
  });

});

app.listen(3000);
