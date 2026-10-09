'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { createTikTokEnvironment } = require('../../tiktok/connection-manager');
class Connection extends EventEmitter {}
const posted = [];
const connections = {};
const settings = {};
const environment = createTikTokEnvironment({
 connector: {WebcastPushConnection:Connection,TikTokLiveConnection:Connection,WebcastDeserializeConfig:{skipMessageTypes:[]}},
 shouldEnableTikTokLogging:false,resolveLogDirectory:()=>null,
 getMainWindow:()=>({webContents:{mainFrame:{frames:[{url:'file:///background.html',postMessage:(channel,payload)=>posted.push(payload)}]}}}),
 websocketConnections:connections,browserViews:{},log:()=>{},onStatus:()=>{},onEvent:()=>{},getCachedSettings:()=>settings,
 isCaptureEventsEnabled:()=>true,isCaptureJoinedEventEnabled:()=>true,isViewerUpdateAllowed:()=>false,isTextOnlyModeEnabled:()=>false,connectionStates:new Map()
});
const manager=new environment.ConnectionManager('unit_test',1,null,null,{});
manager.virtualTabId=900001;manager.connection=new Connection();connections[1]=manager;
manager.giftProcessor.sendGiftMessage({userId:'12345',uniqueId:'john',nickname:'John',giftId:'5655',giftName:'Rose',diamondCount:1,groupId:'group1',common:{msg_id:'native1'},repeatCount:10,repeatEnd:true},10);
const serialized=JSON.stringify(posted);
assert(serialized.includes('"tiktokGiftMessageId":"native1"'),serialized);
assert(serialized.includes('"giftName":"Rose"'),serialized);
assert(serialized.includes('"tiktokGiftCount":10'),serialized);
assert(serialized.includes('"tiktokGiftSenderId":"12345"'),serialized);
assert(serialized.includes('"repeatEnd":true'),serialized);
assert(serialized.includes('"groupId":"group1"'),serialized);
settings.notiktokdonations = {setting:true};
manager.giftProcessor.sendGiftMessage({userId:'12345',nickname:'John',giftId:'5655',giftName:'Rose',diamondCount:1,repeatEnd:true,msgId:'toggle-on'},1);
assert(!posted[posted.length-1].message.hasDonation, 'WebSocket gift must respect the donation toggle');
assert(!posted[posted.length-1].message.donoValue, 'WebSocket gift must not contribute a donation value');
delete settings.notiktokdonations;
manager.giftProcessor.sendGiftMessage({userId:'12345',nickname:'John',giftId:'5655',giftName:'Rose',diamondCount:1,repeatEnd:true,msgId:'toggle-off'},1);
assert(posted[posted.length-1].message.hasDonation, 'Turning the toggle off restores donations without reconnecting');
for (const sample of [
 { giftName: 'Unlisted Gift', count: 20, usd: 0.2, label: '20 gifts' },
 { giftName: 'Finger heart', count: 2, usd: 0.1, label: '10 coins' },
 { giftName: 'Native Diamonds', diamond_count: 10, count: 3, usd: 0.15, label: '30 \uD83D\uDC8E' },
 { giftName: 'Native Coins', gift: { coins: 40 }, count: 3, usd: 1.2, label: '120 coins' },
 { giftId: '5731', count: 2, usd: 9.98, label: '998 coins' },
 { giftName: '  GALAXY  ', count: 2, usd: 20, label: '2000 coins' },
 { giftName: 'TikTok Universe', count: 1, usd: 449.99, label: '44999 coins' },
 { giftPictureUrl: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/d4faa402c32bf4f92bee654b2663d9f1~tplv-obj.png', count: 2, usd: 9.98, label: '998 coins' },
 { giftName: 'Galaxy', gift: { coins: 12 }, count: 3, usd: 0.36, label: '36 coins' }
]) {
 manager.giftProcessor.sendGiftMessage({ userId: '12345', nickname: 'John', repeatEnd: true, ...sample }, sample.count);
 const message = posted[posted.length-1].message;
 assert.strictEqual(message.hasDonation, sample.label);
 assert(Math.abs(message.donoValue - sample.usd) < 1e-10, JSON.stringify(message));
 assert.strictEqual(message.meta.tiktokGiftCount, sample.count);
}
manager.giftProcessor.stop('test_cleanup');
console.log('WebSocket gift TTS metadata passed');
process.exit(0);
