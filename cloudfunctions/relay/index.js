const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const channels = db.collection('relayChannels');
const messages = db.collection('relayMessages');
const uploads = db.collection('relayUploads');
const MESSAGE_TTL_MS = 31 * 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

function fail(message) { throw new Error(message); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function randomToken() { return crypto.randomBytes(24).toString('hex'); }
function encryptionKey() {
  const key = Buffer.from(process.env.RELAY_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) fail('服务端加密密钥未配置');
  return key;
}
function encryptText(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { textCipher: ciphertext.toString('base64'), textIv: iv.toString('base64'), textTag: cipher.getAuthTag().toString('base64') };
}
function decryptText(message) {
  if (!message.textCipher) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(message.textIv, 'base64'));
  decipher.setAuthTag(Buffer.from(message.textTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(message.textCipher, 'base64')),
    decipher.final()
  ]).toString('utf8');
}
function roleFor(channel, openid) {
  if (channel.members.a === openid) return 'a';
  if (channel.members.c === openid) return 'c';
  return '';
}
function assertParticipant(channel, openid) {
  const role = roleFor(channel, openid);
  if (!role || !channel.consents[role]) fail('尚未加入此转接通道');
  if (!channel.consents.b) fail('转接人尚未确认');
  return role;
}
function isReady(channel) {
  return Boolean(channel.members.a && channel.members.c && channel.consents.a && channel.consents.c && channel.consents.b);
}

exports.main = async (event = {}) => {
  const action = typeof event.action === 'string' ? event.action : 'unknown';
  console.info('[relay] invocation', { action });
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) fail('无法识别当前微信用户');

    switch (action) {
    case 'createChannel': {
      if (event.consent !== true) fail('请先确认你会负责这条转接规则');
      const createdAt = Date.now();
      const secretA = randomToken();
      const secretC = randomToken();
      const result = await channels.add({ data: {
        ownerOpenid: OPENID,
        members: { a: '', c: '' },
        consents: { a: false, b: true, c: false },
        inviteHashes: { a: digest(secretA), c: digest(secretC) },
        inviteExpiresAt: createdAt + INVITE_TTL_MS,
        state: 'pending',
        createdAt,
        lastActivityAt: createdAt
      }});
      return {
        channelId: result._id,
        inviteA: `${result._id}:a:${secretA}`,
        inviteC: `${result._id}:c:${secretC}`,
        inviteExpiresAt: createdAt + INVITE_TTL_MS
      };
    }

    case 'joinChannel': {
      if (event.consent !== true) fail('加入前需要确认消息会被转接');
      const parts = String(event.inviteCode || '').split(':');
      const [channelId, role, secret] = parts;
      if (!channelId || !['a', 'c'].includes(role) || !secret) fail('邀请链接无效');
      return db.runTransaction(async (transaction) => {
        const ref = transaction.collection('relayChannels').doc(channelId);
        const { data: channel } = await ref.get();
        if (!channel || channel.inviteExpiresAt < Date.now()) fail('邀请已失效');
        if (channel.ownerOpenid === OPENID) fail('转接人不能占用收发席位');
        if (channel.inviteHashes[role] !== digest(secret)) fail('邀请链接无效');
        if (channel.members[role] && channel.members[role] !== OPENID) fail('这个席位已被加入');
        const otherRole = role === 'a' ? 'c' : 'a';
        if (channel.members[otherRole] === OPENID) fail('同一账号不能占用两个席位');
        const next = {
          ...channel,
          members: { ...channel.members, [role]: OPENID },
          consents: { ...channel.consents, [role]: true },
          inviteHashes: { ...channel.inviteHashes, [role]: '' },
          state: isReady({ ...channel, members: { ...channel.members, [role]: OPENID }, consents: { ...channel.consents, [role]: true } }) ? 'active' : 'pending',
          lastActivityAt: Date.now()
        };
        delete next._id;
        await ref.update({ data: next });
        return { channelId, role, state: next.state };
      });
    }

    case 'getOwnerStatus': {
      const { data: channel } = await channels.doc(event.channelId).get();
      if (!channel || channel.ownerOpenid !== OPENID) fail('只有转接人可以查看规则状态');
      return {
        channelId: event.channelId,
        state: channel.state,
        joined: { a: Boolean(channel.members.a), c: Boolean(channel.members.c) },
        inviteExpiresAt: channel.inviteExpiresAt
      };
    }

    case 'listOwnerChannels': {
      const result = await channels.where({ ownerOpenid: OPENID })
        .orderBy('createdAt', 'desc').limit(100).get();
      return {
        channels: (Array.isArray(result.data) ? result.data : []).map((channel) => ({
          channelId: channel._id,
          state: channel.state,
          joined: {
            a: Boolean(channel.members && channel.members.a),
            c: Boolean(channel.members && channel.members.c)
          },
          inviteExpiresAt: channel.inviteExpiresAt,
          createdAt: channel.createdAt,
          lastActivityAt: channel.lastActivityAt
        }))
      };
    }

    case 'setChannelState': {
      const { data: channel } = await channels.doc(event.channelId).get();
      if (!channel || channel.ownerOpenid !== OPENID) fail('只有转接人可以管理这条规则');
      const nextState = event.active === true ? 'active' : 'paused';
      if (nextState === 'active' && !isReady(channel)) fail('三方确认完成后才能开启');
      await channels.doc(event.channelId).update({ data: { state: nextState, lastActivityAt: Date.now() } });
      return { state: nextState };
    }

    case 'prepareImageUpload': {
      const { data: channel } = await channels.doc(event.channelId).get();
      const role = channel && assertParticipant(channel, OPENID);
      if (!channel || channel.state !== 'active' || !role) fail('转接通道当前不可用');
      const ext = String(event.extension || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
      const uploadPath = `relay-media/${event.channelId}/${randomToken()}.${ext}`;
      await uploads.add({ data: {
        uploadPath,
        channelId: event.channelId,
        openid: OPENID,
        used: false,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60 * 60 * 1000
      }});
      return { uploadPath };
    }

    case 'registerImageUpload': {
      const uploadPath = String(event.uploadPath || '');
      const fileID = String(event.fileID || '');
      if (!uploadPath.startsWith(`relay-media/${event.channelId}/`) || !fileID.startsWith('cloud://') || !fileID.includes(uploadPath)) fail('图片上传凭证无效');
      const { data: channel } = await channels.doc(event.channelId).get();
      assertParticipant(channel, OPENID);
      const result = await uploads.where({ uploadPath, channelId: event.channelId, openid: OPENID, used: false, expiresAt: _.gt(Date.now()) }).limit(1).get();
      if (!result.data.length) fail('图片上传凭证已用或已过期');
      await uploads.doc(result.data[0]._id).update({ data: { fileID } });
      return { ready: true };
    }

    case 'sendMessage': {
      const { data: channel } = await channels.doc(event.channelId).get();
      if (!channel || channel.state !== 'active') fail('转接通道当前不可用');
      const fromRole = assertParticipant(channel, OPENID);
      const toRole = fromRole === 'a' ? 'c' : 'a';
      const createdAt = Date.now();
      const record = {
        channelId: event.channelId,
        fromRole,
        toRole,
        createdAt,
        expiresAt: createdAt + MESSAGE_TTL_MS
      };
      if (event.type === 'text') {
        const text = String(event.text || '').trim();
        if (!text || [...text].length > 500) fail('文字不能为空且不能超过 500 字');
        record.type = 'text';
        Object.assign(record, encryptText(text));
      } else if (event.type === 'image') {
        const uploadPath = String(event.uploadPath || '');
        const fileID = String(event.fileID || '');
        if (!uploadPath.startsWith(`relay-media/${event.channelId}/`) || !fileID.startsWith('cloud://') || !fileID.includes(uploadPath)) fail('图片上传凭证无效');
        const result = await uploads.where({
          uploadPath,
          channelId: event.channelId,
          openid: OPENID,
          fileID,
          used: false,
          expiresAt: _.gt(Date.now())
        }).limit(1).get();
        if (!result.data.length) fail('图片上传凭证已用或已过期');
        record.type = 'image';
        record.fileID = fileID;
        await uploads.doc(result.data[0]._id).update({ data: { used: true, expiresAt: record.expiresAt } });
      } else {
        fail('暂不支持这种消息类型');
      }
      const result = await messages.add({ data: record });
      await channels.doc(event.channelId).update({ data: { lastActivityAt: createdAt } });
      return { messageId: result._id, createdAt, toRole };
    }

    case 'listMessages': {
      if (typeof event.channelId !== 'string' || !event.channelId.trim()) fail('转接通道编号缺失，请重新加入通道');
      const channelId = event.channelId.trim();
      const { data: channel } = await channels.doc(channelId).get();
      const role = channel && assertParticipant(channel, OPENID);
      if (!channel || !role) fail('无权读取这条转接会话');
      const cursor = Number(event.after || 0);
      if (!Number.isFinite(cursor) || cursor < 0) fail('消息读取位置无效');
      const result = await messages.where({ channelId, createdAt: _.gt(cursor), expiresAt: _.gt(Date.now()) })
        .orderBy('createdAt', 'asc').limit(100).get();
      const records = Array.isArray(result.data) ? result.data.filter(Boolean) : [];
      const media = records.filter((message) => message && typeof message.fileID === 'string' && message.fileID.startsWith('cloud://'));
      const urls = media.length ? await cloud.getTempFileURL({ fileList: media.map((message) => message.fileID) }) : { fileList: [] };
      const urlById = new Map(((urls && Array.isArray(urls.fileList)) ? urls.fileList : [])
        .filter((item) => item && typeof item.fileID === 'string')
        .map((item) => [item.fileID, item.tempFileURL || '']));
      return {
        state: channel.state,
        role,
        messages: records.map((message) => ({
          id: message._id,
          fromRole: message.fromRole,
          type: message.type,
          text: decryptText(message),
          imageUrl: message.fileID ? (urlById.get(message.fileID) || '') : '',
          createdAt: message.createdAt
        }))
      };
    }

      default:
        fail('未知操作');
    }
  } catch (error) {
    console.error('[relay] invocation failed', {
      action,
      message: error && error.message ? error.message : String(error)
    });
    throw error;
  }
};
