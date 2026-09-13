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
manager.giftProcessor.stop('test_cleanup');
console.log('WebSocket gift TTS metadata passed');
process.exit(0);
