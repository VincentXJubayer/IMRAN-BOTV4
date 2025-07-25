"use strict";
// Fixed by @NethWs3Dev
// Chopchop wood from other fca
var utils = require("../utils");
var mqtt = require('mqtt');
var websocket = require('websocket-stream');
var HttpsProxyAgent = require('https-proxy-agent');
const EventEmitter = require('events');
var identity = () => {};
var form = {};
var getSeqID = () => {};
var topics = [
  "/legacy_web",
  "/webrtc",
  "/rtc_multi",
  "/onevc",
  "/br_sr", //Notification
  //Need to publish /br_sr right after this
  "/sr_res",
  "/t_ms",
  "/thread_typing",
  "/orca_typing_notifications",
  "/notify_disconnect",
  //Need to publish /messenger_sync_create_queue right after this
  "/orca_presence",
  //Will receive /sr_res right here.
  "/inbox",
  "/mercury",
  "/messaging_events",
  "/orca_message_notifications",
  "/pp",
  "/webrtc_response",
];

function listenMqtt(defaultFuncs, api, ctx, globalCallback) {
  //Don't really know what this does but I think it's for the active state?
  //TODO: Move to ctx when implemented
  var chatOn = ctx.globalOptions.online;
  var foreground = false;
  const sessionID = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
  const GUID = utils.getGUID()
  const username = {
    u: ctx.userID,
    s: sessionID,
    chat_on: chatOn,
    fg: foreground,
    d: GUID,
    ct: 'websocket',
    aid: '219994525426954',
    aids: null,
    mqtt_sid: '',
    cp: 3,
    ecp: 10,
    st: [],
    pm: [],
    dc: '',
    no_auto_fg: true,
    gas: null,
    pack: [],
    a: ctx.globalOptions.userAgent,
    p: null,
    aids: null,
    php_override: ""
  };
  const cookies = ctx.jar.getCookies('https://www.facebook.com').join('; ');
  let host;
  if (ctx.mqttEndpoint) {
    host = `${ctx.mqttEndpoint}&sid=${sessionID}`;
  } else if (ctx.region) {
    host = `wss://edge-chat.facebook.com/chat?region=${ctx.region.toLowerCase()}&sid=${sessionID}`;
  } else {
    host = `wss://edge-chat.facebook.com/chat?sid=${sessionID}`;
  }
  const options = {
    clientId: 'mqttwsclient',
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    username: JSON.stringify(username),
    clean: true,
    wsOptions: {
      headers: {
        Cookie: cookies,
        Origin: 'https://www.facebook.com',
        Referer: 'https://www.facebook.com/',
        "User-Agent": username.a,
        Host: new URL(host).hostname,
      },
      origin: 'https://www.facebook.com',
      protocolVersion: 13,
      binaryType: 'arraybuffer',
    },
    keepalive: 10,
    reschedulePings: true,
    connectTimeout: 10 * 1000,
    reconnectPeriod: 1 * 1000,
  };
  if (typeof ctx.globalOptions.proxy != "undefined") {
    var agent = new HttpsProxyAgent(ctx.globalOptions.proxy);
    options.wsOptions.agent = agent;
  }
  ctx.mqttClient = new mqtt.Client(_ => websocket(host, options.wsOptions), options);
  var mqttClient = ctx.mqttClient;
  function stopListening() {
    if (mqttClient) {
      mqttClient.unsubscribe("/webrtc");
      mqttClient.unsubscribe("/rtc_multi");
      mqttClient.unsubscribe("/onevc");
      mqttClient.publish("/browser_close", "{}");
      mqttClient.end(false, function(...data) {
        ctx.mqttClient = null;
        mqttClient = null;
      });
    }
  }
  mqttClient.on('error', function(err) {
    stopListening();
    if (ctx.globalOptions.autoReconnect) {
      getSeqID();
    } else {
      globalCallback({ type: "stop_listen", error: "Connection refused: Server unavailable" }, null);
    }
    utils.warn("Error detected. Will relogin automatically...");
    api.ws3.relogin();
    return;
  });

  mqttClient.on('connect', () => {
    topics.forEach(topicsub => mqttClient.subscribe(topicsub));
    var topic;
    var queue = {
      sync_api_version: 10,
      max_deltas_able_to_process: 1000,
      delta_batch_size: 500,
      encoding: "JSON",
      entity_fbid: ctx.userID,
    };

    if (ctx.syncToken) {
      topic = "/messenger_sync_get_diffs";
      queue.last_seq_id = ctx.lastSeqId;
      queue.sync_token = ctx.syncToken;
    } else {
      topic = "/messenger_sync_create_queue";
      queue.initial_titan_sequence_id = ctx.lastSeqId;
      queue.device_params = null;
    }
    mqttClient.publish(topic, JSON.stringify(queue), { qos: 1, retain: false });
    mqttClient.publish("/foreground_state", JSON.stringify({ foreground: chatOn }), { qos: 1 });
    mqttClient.publish("/set_client_settings", JSON.stringify({ make_user_available_when_in_foreground: true }), { qos: 1 });
    const rTimeout = setTimeout(() => {
      mqttClient.end();
      listenMqtt(defaultFuncs, api, ctx, globalCallback);
    }, 3000);
    ctx.tmsWait = () => {
      clearTimeout(rTimeout);
      ctx.globalOptions.emitReady ? globalCallback({
        type: "ready",
        error: null
      }) : "";
      delete ctx.tmsWait;
    };
  });

  mqttClient.on('message', (topic, message, _packet) => {
    try {
      var jsonMessage = JSON.parse(message);
    } catch (ex) {
      return utils.error("listenMqtt", ex);
    }
    if (topic === "/t_ms") {
      if (ctx.tmsWait && typeof ctx.tmsWait == "function") ctx.tmsWait();
      if (jsonMessage.firstDeltaSeqId && jsonMessage.syncToken) {
        ctx.lastSeqId = jsonMessage.firstDeltaSeqId;
        ctx.syncToken = jsonMessage.syncToken;
      }
      if (jsonMessage.lastIssuedSeqId) ctx.lastSeqId = parseInt(jsonMessage.lastIssuedSeqId);
      //If it contains more than 1 delta
      for (var i in jsonMessage.deltas) {
        var delta = jsonMessage.deltas[i];
        parseDelta(defaultFuncs, api, ctx, globalCallback, { "delta": delta });
      }
    } else if (topic === "/thread_typing" || topic === "/orca_typing_notifications") {
      var typ = {
        type: "typ",
        isTyping: !!jsonMessage.state,
        from: jsonMessage.sender_fbid.toString(),
        threadID: utils.formatID((jsonMessage.thread || jsonMessage.sender_fbid).toString())
      };
      (function() { globalCallback(null, typ); })();
    } else if (topic === "/orca_presence") {
      if (!ctx.globalOptions.updatePresence) {
        for (var i in jsonMessage.list) {
          var data = jsonMessage.list[i];
          var userID = data["u"];
          var presence = {
            type: "presence",
            userID: userID.toString(),
            //Convert to ms
            timestamp: data["l"] * 1000,
            statuses: data["p"]
          };
          (function() { globalCallback(null, presence); })();
        }
      }
    }
  });
  mqttClient.on('close', () => {});
  mqttClient.on('disconnect', () => {});
}

function parseDelta(defaultFuncs, api, ctx, globalCallback, v) {
  if (v.delta.class == "NewMessage") {
    //Not tested for pages
    if (ctx.globalOptions.pageID && ctx.globalOptions.pageID != v.queue) return;
    (function resolveAttachmentUrl(i) {
      if (v.delta.attachments && (i == v.delta.attachments.length)) {
        var fmtMsg;
        try {
          fmtMsg = utils.formatDeltaMessage(v);
        } catch (err) {
          return globalCallback({
            error: "Problem parsing message object. Please open an issue at https://github.com/Schmavery/facebook-chat-api/issues.",
            detail: err,
            res: v,
            type: "parse_error"
          });
        }
        if (fmtMsg)
          if (ctx.globalOptions.autoMarkDelivery) markDelivery(ctx, api, fmtMsg.threadID, fmtMsg.messageID);

        return !ctx.globalOptions.selfListen && fmtMsg.senderID === ctx.userID ? undefined : (function() { globalCallback(null, fmtMsg); })();
      } else {
        if (v.delta.attachments && (v.delta.attachments[i].mercury.attach_type == "photo")) {
          api.resolvePhotoUrl(v.delta.attachments[i].fbid, (err, url) => {
            if (!err) v.delta.attachments[i].mercury.metadata.url = url;
            return resolveAttachmentUrl(i + 1);
          });
        } else return resolveAttachmentUrl(i + 1);
      }
    })(0);
  }

  if (v.delta.class == "ClientPayload") {
    var clientPayload = utils.decodeClientPayload(v.delta.payload);
    if (clientPayload && clientPayload.deltas) {
      for (var i in clientPayload.deltas) {
        var delta = clientPayload.deltas[i];
        if (delta.deltaMessageReaction && !!ctx.globalOptions.listenEvents) {
          (function() {
            globalCallback(null, {
              type: "message_reaction",
              threadID: (delta.deltaMessageReaction.threadKey.threadFbId ? delta.deltaMessageReaction.threadKey.threadFbId : delta.deltaMessageReaction.threadKey.otherUserFbId).toString(),
              messageID: delta.deltaMessageReaction.messageId,
              reaction: delta.deltaMessageReaction.reaction,
              senderID: delta.deltaMessageReaction.senderId.toString(),
              userID: delta.deltaMessageReaction.userId.toString()
            });
          })();
        } else if (delta.deltaRecallMessageData && !!ctx.globalOptions.listenEvents) {
          (function() {
            globalCallback(null, {
              type: "message_unsend",
              threadID: (delta.deltaRecallMessageData.threadKey.threadFbId ? delta.deltaRecallMessageData.threadKey.threadFbId : delta.deltaRecallMessageData.threadKey.otherUserFbId).toString(),
              messageID: delta.deltaRecallMessageData.messageID,
              senderID: delta.deltaRecallMessageData.senderID.toString(),
              deletionTimestamp: delta.deltaRecallMessageData.deletionTimestamp,
              timestamp: delta.deltaRecallMessageData.timestamp
            });
          })();
        } else if (delta.deltaMessageReply) {
          //Mention block - #1
          var mdata =
            delta.deltaMessageReply.message === undefined ? [] :
            delta.deltaMessageReply.message.data === undefined ? [] :
            delta.deltaMessageReply.message.data.prng === undefined ? [] :
            JSON.parse(delta.deltaMessageReply.message.data.prng);
          var m_id = mdata.map(u => u.i);
          var m_offset = mdata.map(u => u.o);
          var m_length = mdata.map(u => u.l);
          var mentions = {};
          for (var i = 0; i < m_id.length; i++) mentions[m_id[i]] = (delta.deltaMessageReply.message.body || "").substring(m_offset[i], m_offset[i] + m_length[i]);
          //Mention block - 1#
          var callbackToReturn = {
            type: "message_reply",
            threadID: (delta.deltaMessageReply.message.messageMetadata.threadKey.threadFbId ? delta.deltaMessageReply.message.messageMetadata.threadKey.threadFbId : delta.deltaMessageReply.message.messageMetadata.threadKey.otherUserFbId).toString(),
            messageID: delta.deltaMessageReply.message.messageMetadata.messageId,
            senderID: delta.deltaMessageReply.message.messageMetadata.actorFbId.toString(),
            attachments: delta.deltaMessageReply.message.attachments.map(function(att) {
              var mercury = JSON.parse(att.mercuryJSON);
              Object.assign(att, mercury);
              return att;
            }).map(att => {
              var x;
              try {
                x = utils._formatAttachment(att);
              } catch (ex) {
                x = att;
                x.error = ex;
                x.type = "unknown";
              }
              return x;
            }),
            args: (delta.deltaMessageReply.message.body || "").trim().split(/\s+/),
            body: (delta.deltaMessageReply.message.body || ""),
            isGroup: !!delta.deltaMessageReply.message.messageMetadata.threadKey.threadFbId,
            mentions,
            timestamp: delta.deltaMessageReply.message.messageMetadata.timestamp,
            participantIDs: (delta.deltaMessageReply.message.participants || []).map(e => e.toString())
          };

          if (delta.deltaMessageReply.repliedToMessage) {
            //Mention block - #2
            mdata =
              delta.deltaMessageReply.repliedToMessage === undefined ? [] :
              delta.deltaMessageReply.repliedToMessage.data === undefined ? [] :
              delta.deltaMessageReply.repliedToMessage.data.prng === undefined ? [] :
              JSON.parse(delta.deltaMessageReply.repliedToMessage.data.prng);
            m_id = mdata.map(u => u.i);
            m_offset = mdata.map(u => u.o);
            m_length = mdata.map(u => u.l);

            var rmentions = {};

            for (var i = 0; i < m_id.length; i++) rmentions[m_id[i]] = (delta.deltaMessageReply.repliedToMessage.body || "").substring(m_offset[i], m_offset[i] + m_length[i]);
            //Mention block - 2#
            callbackToReturn.messageReply = {
              threadID: (delta.deltaMessageReply.repliedToMessage.messageMetadata.threadKey.threadFbId ? delta.deltaMessageReply.repliedToMessage.messageMetadata.threadKey.threadFbId : delta.deltaMessageReply.repliedToMessage.messageMetadata.threadKey.otherUserFbId).toString(),
              messageID: delta.deltaMessageReply.repliedToMessage.messageMetadata.messageId,
              senderID: delta.deltaMessageReply.repliedToMessage.messageMetadata.actorFbId.toString(),
              attachments: delta.deltaMessageReply.repliedToMessage.attachments.map(function(att) {
                var mercury = JSON.parse(att.mercuryJSON);
                Object.assign(att, mercury);
                return att;
              }).map(att => {
                var x;
                try {
                  x = utils._formatAttachment(att);
                } catch (ex) {
                  x = att;
                  x.error = ex;
                  x.type = "unknown";
                }
                return x;
              }),
              args: (delta.deltaMessageReply.repliedToMessage.body || "").trim().split(/\s+/),
              body: delta.deltaMessageReply.repliedToMessage.body || "",
              isGroup: !!delta.deltaMessageReply.repliedToMessage.messageMetadata.threadKey.threadFbId,
              mentions: rmentions,
              timestamp: delta.deltaMessageReply.repliedToMessage.messageMetadata.timestamp,
              participantIDs: (delta.deltaMessageReply.repliedToMessage.participants || []).map(e => e.toString())
            };
          } else if (delta.deltaMessageReply.replyToMessageId) {
            return defaultFuncs
              .post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, {
                "av": ctx.globalOptions.pageID,
                "queries": JSON.stringify({
                  "o0": {
                    //Using the same doc_id as forcedFetch
                    "doc_id": "2848441488556444",
                    "query_params": {
                      "thread_and_message_id": {
                        "thread_id": callbackToReturn.threadID,
                        "message_id": delta.deltaMessageReply.replyToMessageId.id,
                      }
                    }
                  }
                })
              })
              .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
              .then((resData) => {
                if (resData[resData.length - 1].error_results > 0) {
                  const errorL = resData[0].o0.errors;
                  throw errorL;
                }
                if (resData[resData.length - 1].successful_results === 0) throw { error: "forcedFetch: there was no successful_results", res: resData };
                var fetchData = resData[0].o0.data.message;
                var mobj = {};
                for (var n in fetchData.message.ranges) mobj[fetchData.message.ranges[n].entity.id] = (fetchData.message.text || "").substr(fetchData.message.ranges[n].offset, fetchData.message.ranges[n].length);

                callbackToReturn.messageReply = {
                  threadID: callbackToReturn.threadID,
                  messageID: fetchData.message_id,
                  senderID: fetchData.message_sender.id.toString(),
                  attachments: fetchData.message.blob_attachment.map(att => {
                    var x;
                    try {
                      x = utils._formatAttachment({ blob_attachment: att });
                    } catch (ex) {
                      x = att;
                      x.error = ex;
                      x.type = "unknown";
                    }
                    return x;
                  }),
                  args: (fetchData.message.text || "").trim().split(/\s+/) || [],
                  body: fetchData.message.text || "",
                  isGroup: callbackToReturn.isGroup,
                  mentions: mobj,
                  timestamp: parseInt(fetchData.timestamp_precise),
                };
              })
              .catch(err => utils.error("forcedFetch", err))
              .finally(() => {
                if (ctx.globalOptions.autoMarkDelivery) markDelivery(ctx, api, callbackToReturn.threadID, callbackToReturn.messageID);
                !ctx.globalOptions.selfListen && callbackToReturn.senderID === ctx.userID ? undefined : (function() { globalCallback(null, callbackToReturn); })();
              });
          } else callbackToReturn.delta = delta;
          if (ctx.globalOptions.autoMarkDelivery) markDelivery(ctx, api, callbackToReturn.threadID, callbackToReturn.messageID);
          return !ctx.globalOptions.selfListen && callbackToReturn.senderID === ctx.userID ? undefined : (function() { globalCallback(null, callbackToReturn); })();
        }
      }
      return;
    }
  }

  if (v.delta.class !== "NewMessage" && !ctx.globalOptions.listenEvents) return;
  switch (v.delta.class) {
    case "ReadReceipt":
      var fmtMsg;
      try {
        fmtMsg = utils.formatDeltaReadReceipt(v.delta);
      } catch (err) {
        return globalCallback({
          error: "Problem parsing message object. Please open an issue at https://github.com/Schmavery/facebook-chat-api/issues.",
          detail: err,
          res: v.delta,
          type: "parse_error"
        });
      }
      return (function() { globalCallback(null, fmtMsg); })();
    case "AdminTextMessage":
      switch (v.delta.type) {
        case "change_thread_theme":
        case "change_thread_nickname":
        case "change_thread_admins":
        case "change_thread_approval_mode":
        case "joinable_group_link_mode_change":
        case "rtc_call_log":
        case "group_poll":
        case "update_vote":
        case "magic_words":
        case "messenger_call_log":
        case "participant_joined_group_call":
          var fmtMsg;
          try {
            fmtMsg = utils.formatDeltaEvent(v.delta);
          } catch (err) {
            return globalCallback({
              error: "Problem parsing message object. Please open an issue at https://github.com/Schmavery/facebook-chat-api/issues.",
              detail: err,
              res: v.delta,
              type: "parse_error"
            });
          }
          return (function() { globalCallback(null, fmtMsg); })();
        default:
          return;
      }
      break;
      //For group images
    case "ForcedFetch":
      if (!v.delta.threadKey) return;
      var mid = v.delta.messageId;
      var tid = v.delta.threadKey.threadFbId;
      if (mid && tid) {
        const form = {
          "av": ctx.globalOptions.pageID,
          "queries": JSON.stringify({
            "o0": {
              //This doc_id is valid as of March 25, 2020
              "doc_id": "2848441488556444",
              "query_params": {
                "thread_and_message_id": {
                  "thread_id": tid.toString(),
                  "message_id": mid,
                }
              }
            }
          })
        };

        defaultFuncs
          .post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, form)
          .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
          .then((resData) => {
            if (resData[resData.length - 1].error_results > 0) {
              const errorL = resData[0].o0.errors;
              throw errorL;
            }

            if (resData[resData.length - 1].successful_results === 0) throw { error: "forcedFetch: there was no successful_results", res: resData };

            var fetchData = resData[0].o0.data.message;

            if (utils.getType(fetchData) == "Object") {
              utils.log("forcedFetch", fetchData);
              switch (fetchData.__typename) {
                case "ThreadImageMessage":
                  (!ctx.globalOptions.selfListen &&
                    fetchData.message_sender.id.toString() === ctx.userID) ||
                  !ctx.loggedIn ?
                    undefined :
                    (function() {
                      globalCallback(null, {
                        type: "change_thread_image",
                        threadID: utils.formatID(tid.toString()),
                        snippet: fetchData.snippet,
                        timestamp: fetchData.timestamp_precise,
                        author: fetchData.message_sender.id,
                        image: {
                          attachmentID: fetchData.image_with_metadata && fetchData.image_with_metadata.legacy_attachment_id,
                          width: fetchData.image_with_metadata && fetchData.image_with_metadata.original_dimensions.x,
                          height: fetchData.image_with_metadata && fetchData.image_with_metadata.original_dimensions.y,
                          url: fetchData.image_with_metadata && fetchData.image_with_metadata.preview.uri
                        }
                      });
                    })();
                  break;
                case "UserMessage":
                  utils.log("ff-Return", {
                    type: "message",
                    senderID: utils.formatID(fetchData.message_sender.id),
                    body: fetchData.message.text || "",
                    threadID: utils.formatID(tid.toString()),
                    messageID: fetchData.message_id,
                    attachments: [{
                      type: "share",
                      ID: fetchData.extensible_attachment.legacy_attachment_id,
                      url: fetchData.extensible_attachment.story_attachment.url,

                      title: fetchData.extensible_attachment.story_attachment.title_with_entities.text,
                      description: fetchData.extensible_attachment.story_attachment.description.text,
                      source: fetchData.extensible_attachment.story_attachment.source,

                      image: ((fetchData.extensible_attachment.story_attachment.media || {}).image || {}).uri,
                      width: ((fetchData.extensible_attachment.story_attachment.media || {}).image || {}).width,
                      height: ((fetchData.extensible_attachment.story_attachment.media || {}).image || {}).height,
                      playable: (fetchData.extensible_attachment.story_attachment.media || {}).is_playable || false,
                      duration: (fetchData.extensible_attachment.story_attachment.media || {}).playable_duration_in_ms || 0,

                      subattachments: fetchData.extensible_attachment.subattachments,
                      properties: fetchData.extensible_attachment.story_attachment.properties,
                    }],
                    mentions: {},
                    timestamp: parseInt(fetchData.timestamp_precise),
                    isGroup: (fetchData.message_sender.id != tid.toString())
                  });
                  globalCallback(null, {
                    type: "message",
                    senderID: utils.formatID(fetchData.message_sender.id),
                    body: fetchData.message.text || "",
                    threadID: utils.formatID(tid.toString()),
                    messageID: fetchData.message_id,
                    attachments: [{
                      type: "share",
                      ID: fetchData.extensible_attachment.legacy_attachment_id,
                      url: fetchData.extensible_attachment.story_attachment.url,

                      title: fetchData.extensible_attachment.story_attachment.title_with_entities.text,
                      description: fetchData.extensible_attachment.story_attachment.description.text,
                      source: fetchData.extensible_attachment.story_attachment.source,

                      image: ((fetchData.extensible_attachment.story_attachment.media || {}).image || {}).uri,
                      width: ((fetchData.extensible_attachment.story_attachment.media || {}).image || {}).width,
                      height: ((fetchData.extensible_attachment.story_attachment.media || {}).image || {}).height,
                      playable: (fetchData.extensible_attachment.story_attachment.media || {}).is_playable || false,
                      duration: (fetchData.extensible_attachment.story_attachment.media || {}).playable_duration_in_ms || 0,

                      subattachments: fetchData.extensible_attachment.subattachments,
                      properties: fetchData.extensible_attachment.story_attachment.properties,
                    }],
                    mentions: {},
                    timestamp: parseInt(fetchData.timestamp_precise),
                    isGroup: (fetchData.message_sender.id != tid.toString())
                  });
              }
            } else utils.error("forcedFetch", fetchData);
          })
          .catch((err) => utils.error("forcedFetch", err));
      }
      break;
    case "ThreadName":
    case "ParticipantsAddedToGroupThread":
    case "ParticipantLeftGroupThread":
      var formattedEvent;
      try {
        formattedEvent = utils.formatDeltaEvent(v.delta);
      } catch (err) {
        return globalCallback({
          error: "Problem parsing message object. Please open an issue at https://github.com/Schmavery/facebook-chat-api/issues.",
          detail: err,
          res: v.delta,
          type: "parse_error"
        });
      }
      return (!ctx.globalOptions.selfListen && formattedEvent.author.toString() === ctx.userID) || !ctx.loggedIn ? undefined : (function() { globalCallback(null, formattedEvent); })();
  }
}

function markDelivery(ctx, api, threadID, messageID) {
  if (threadID && messageID) {
    api.markAsDelivered(threadID, messageID, (err) => {
      if (err) utils.error("markAsDelivered", err);
      else {
        if (ctx.globalOptions.autoMarkRead) {
          api.markAsRead(threadID, (err) => {
            if (err) utils.error("markAsDelivered", err);
          });
        }
      }
    });
  }
}

module.exports = function(defaultFuncs, api, ctx) {
  var globalCallback = identity;
  getSeqID = function getSeqID() {
    ctx.t_mqttCalled = false;
    defaultFuncs
      .post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, form)
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then((resData) => {
        if (utils.getType(resData) != "Array")
          throw { error: "Not logged in", res: resData };
        if (resData[resData.length - 1].error_results > 0) {
          const errorL = resData[0].o0.errors;
          throw errorL;
        }
        if (resData[resData.length - 1].successful_results === 0) throw { error: "getSeqId: there was no successful_results", res: resData };
        if (resData[0].o0.data.viewer.message_threads.sync_sequence_id) {
          ctx.lastSeqId = resData[0].o0.data.viewer.message_threads.sync_sequence_id;
          listenMqtt(defaultFuncs, api, ctx, globalCallback);
        } else throw { error: "getSeqId: no sync_sequence_id found.", res: resData };
      })
      .catch((err) => {
        if (utils.getType(err) == "Object" && err.error === "Not logged in") {
          ctx.loggedIn = false;
        }
        return globalCallback(err);
      });
  };

  return async (callback) => {
    var msgEmitter = new EventEmitter();
    globalCallback = (callback || function(error, message) {
      if (error) return msgEmitter.emit("error", error);
      msgEmitter.emit("message", message);
    });
    //Reset some stuff
    if (!ctx.firstListen) ctx.lastSeqId = null;
    ctx.syncToken = undefined;
    ctx.t_mqttCalled = false;
    //Same request as getThreadList
    form = {
      "av": ctx.globalOptions.pageID,
      "queries": JSON.stringify({
        "o0": {
          "doc_id": "3336396659757871",
          "query_params": {
            "limit": 1,
            "before": null,
            "tags": ["INBOX"],
            "includeDeliveryReceipts": false,
            "includeSeqID": true
          }
        }
      })
    };
    if (!ctx.firstListen || !ctx.lastSeqId) getSeqID();
    else listenMqtt(defaultFuncs, api, ctx, globalCallback);
    ctx.firstListen = false;
    return msgEmitter;
  };
};