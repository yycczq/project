function call(action, data = {}) {
  const payload = { action };
  Object.keys(data || {}).forEach((key) => {
    if (data[key] !== undefined) payload[key] = data[key];
  });

  return wx.cloud.callFunction({ name: 'relay', data: payload }).then((response) => {
    if (!response || !response.result || typeof response.result !== 'object') {
      throw new Error(`relay 云函数 ${action} 返回格式异常`);
    }
    return response.result;
  }).catch((error) => {
    console.error('[relay] cloud function failed', {
      action,
      errCode: error && error.errCode,
      errMsg: error && error.errMsg,
      message: error && error.message,
      requestID: error && (error.requestID || error.requestId)
    });
    throw error;
  });
}

module.exports = {
  createChannel: (consent) => call('createChannel', { consent }),
  joinChannel: (inviteCode, consent) => call('joinChannel', { inviteCode, consent }),
  getOwnerStatus: (channelId) => call('getOwnerStatus', { channelId }),
  listOwnerChannels: () => call('listOwnerChannels'),
  setChannelState: (channelId, active) => call('setChannelState', { channelId, active }),
  prepareImageUpload: (channelId, extension) => call('prepareImageUpload', { channelId, extension }),
  registerImageUpload: (channelId, uploadPath, fileID) => call('registerImageUpload', { channelId, uploadPath, fileID }),
  sendText: (channelId, text) => call('sendMessage', { channelId, type: 'text', text }),
  sendImage: (channelId, uploadPath, fileID) => call('sendMessage', { channelId, type: 'image', uploadPath, fileID }),
  listMessages: (channelId, after = 0) => {
    if (typeof channelId !== 'string' || !channelId.trim()) {
      return Promise.reject(new Error('转接通道编号缺失，请重新加入通道'));
    }
    const cursor = Number(after);
    if (!Number.isFinite(cursor) || cursor < 0) {
      return Promise.reject(new Error('消息读取位置无效，请重新进入会话'));
    }
    return call('listMessages', { channelId: channelId.trim(), after: cursor });
  }
};
