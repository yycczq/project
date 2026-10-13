const relayApi = require('../../services/relay');

Page({
  data: {
    cloudReady: false,
    consent: false,
    joinConsent: false,
    inviteCode: '',
    joinError: '',
    ownerChannels: [],
    ownerChannelsError: '',
    busy: false,
    copiedSeat: '',
    copiedChannelId: '',
    busyChannelId: '',
    createError: ''
  },

  onLoad() {
    const app = getApp();
    this.setData({ cloudReady: Boolean(app.globalData.cloudReady) });
    if (app.globalData.cloudReady) {
      this.loadOwnerChannels().catch((error) => {
        this.setData({ ownerChannelsError: error.message || '暂时无法读取转接列表，请稍后刷新' });
      });
    }
  },

  loadOwnerChannels() {
    return relayApi.listOwnerChannels().then((result) => {
      const inviteById = new Map(this.data.ownerChannels.map((channel) => [channel.channelId, {
        inviteA: channel.inviteA,
        inviteC: channel.inviteC
      }]));
      const ownerChannels = (Array.isArray(result.channels) ? result.channels : []).map((channel) => ({
        ...channel,
        ...inviteById.get(channel.channelId),
        shortId: String(channel.channelId || '').slice(-6),
        copiedSeat: ''
      }));
      this.setData({ ownerChannels, ownerChannelsError: '' });
      if (ownerChannels.length) wx.setStorageSync('relayOwnerChannel', ownerChannels[0].channelId);
      else wx.removeStorageSync('relayOwnerChannel');
      return ownerChannels;
    });
  },

  toggleOwnerChannel(event) {
    const channelId = event.currentTarget.dataset.channelId;
    const channel = this.data.ownerChannels.find((item) => item.channelId === channelId);
    if (!channel || this.data.busy) return;
    const active = channel.state !== 'active';
    this.setData({ busy: true, busyChannelId: channelId });
    relayApi.setChannelState(channelId, active).then(() => this.loadOwnerChannels())
      .catch((error) => this.toast(error.message || '更新失败'))
      .finally(() => this.setData({ busy: false, busyChannelId: '' }));
  },

  onConsentChange(event) {
    this.setData({ consent: (event.detail.value || []).includes('yes') });
  },

  onJoinConsentChange(event) {
    this.setData({ joinConsent: (event.detail.value || []).includes('yes') });
  },

  onInviteInput(event) {
    this.setData({ inviteCode: event.detail.value.trim(), joinError: '' });
  },

  async createChannel() {
    if (!this.data.cloudReady) return this.toast('先配置 CloudBase 环境');
    if (!this.data.consent) return this.toast('请先确认转接说明');
    if (this.data.busy) return;
    this.setData({ busy: true, createError: '' });
    try {
      const channel = await relayApi.createChannel(true);
      if (!channel || !channel.channelId || !channel.inviteA || !channel.inviteC) {
        throw new Error('云函数没有返回发送方和接收方口令，请重新部署 relay 云函数后再创建');
      }
      const created = {
        ...channel,
        state: 'pending',
        joined: { a: false, c: false },
        createdAt: Date.now(),
        shortId: String(channel.channelId).slice(-6),
        copiedSeat: ''
      };
      this.setData({
        ownerChannels: [created, ...this.data.ownerChannels.filter((item) => item.channelId !== channel.channelId)],
        consent: false
      });
      wx.setStorageSync('relayOwnerChannel', channel.channelId);
      this.loadOwnerChannels().catch((error) => {
        this.setData({ ownerChannelsError: error.message || '转接已创建，但列表刷新失败，请下拉重试' });
      });
    } catch (error) {
      const code = error && error.errCode ? `（${error.errCode}）` : '';
      const detail = error && (error.errMsg || error.message) || '云函数没有返回详细错误';
      const requestId = error && (error.requestID || error.requestId);
      const createError = `创建失败${code}：${detail}${requestId ? `；请求 ID：${requestId}` : ''}`;
      console.error('[setup] create channel failed', {
        errCode: error && error.errCode,
        errMsg: error && error.errMsg,
        message: error && error.message,
        requestID: requestId
      });
      this.setData({ createError });
      this.toast('创建失败，页面已显示错误详情');
    } finally {
      this.setData({ busy: false });
    }
  },

  joinChannel() {
    if (!this.data.cloudReady) return this.toast('先配置 CloudBase 环境');
    if (!this.data.joinConsent) return this.toast('请先确认消息转接说明');
    if (!this.data.inviteCode) return this.toast('请粘贴朋友发来的邀请口令');
    if (this.data.busy) return;
    const parts = this.data.inviteCode.split(':');
    const [channelId, role, secret] = parts;
    if (parts.length !== 3 || !channelId || !['a', 'c'].includes(role) || !secret) {
      this.setData({ joinError: '口令格式不完整。请点“复制发送方口令”或“复制接收方口令”，把完整口令私下发给对应参与者。' });
      return;
    }
    const ownedChannel = this.data.ownerChannels.some((item) => item.channelId === channelId);
    const legacyOwnerChannelId = wx.getStorageSync('relayOwnerChannel');
    if (ownedChannel || channelId === legacyOwnerChannelId) {
      this.setData({ joinError: '你是这条通道的转接人，不需要再加入。请把发送方和接收方口令分别发给两位参与者。' });
      return;
    }
    this.setData({ busy: true });
    relayApi.joinChannel(this.data.inviteCode, true).then((result) => {
      wx.setStorageSync('relayChannel', result.channelId);
      wx.setStorageSync('relayRole', result.role);
      wx.redirectTo({ url: `/pages/relay/relay?channelId=${encodeURIComponent(result.channelId)}&role=${result.role}` });
    }).catch((error) => {
      const detail = String((error && (error.errMsg || error.message)) || '');
      const message = detail.includes('-504002')
        ? '加入失败：口令未被服务端识别。请使用完整口令；转接人无需加入，请让发送方或接收方账号操作。'
        : (error.message || '加入失败，请核对口令后重试');
      this.setData({ joinError: message });
      this.toast(message.length > 18 ? '加入失败，查看页面提示' : message);
    }).finally(() => this.setData({ busy: false }));
  },

  copyInvite(event) {
    const dataset = event.currentTarget.dataset || {};
    const seat = dataset.seat;
    const channelId = dataset.channelId;
    const channel = this.data.ownerChannels.find((item) => item.channelId === channelId) || {};
    const code = dataset.code || (seat === 'a' ? channel.inviteA : channel.inviteC);
    if (!code) {
      const detail = '口令数据缺失。请确认 relay 云函数已部署到当前环境，并重新创建转接。';
      this.setData({ createError: detail });
      return this.toast('口令数据缺失，页面已显示详情');
    }
    wx.setClipboardData({
      data: code,
      success: () => {
        const ownerChannels = this.data.ownerChannels.map((item) => ({
          ...item,
          copiedSeat: item.channelId === channelId ? seat : ''
        }));
        this.setData({ ownerChannels, copiedChannelId: channelId, copiedSeat: seat });
        this.toast('口令已复制，去微信私聊粘贴发送');
        clearTimeout(this._copiedTimer);
        this._copiedTimer = setTimeout(() => {
          this.setData({
            copiedChannelId: '',
            copiedSeat: '',
            ownerChannels: this.data.ownerChannels.map((item) => ({ ...item, copiedSeat: '' }))
          });
        }, 2600);
      },
      fail: () => this.toast('复制失败，请再点一次')
    });
  },

  openDemo() {
    wx.navigateTo({ url: '/pages/relay/relay' });
  },

  toast(title) {
    wx.showToast({ title, icon: 'none', duration: 1800 });
  },

  onUnload() {
    clearTimeout(this._copiedTimer);
  }
});
