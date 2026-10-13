const config = require('../../config');
const relayApi = require('../../services/relay');

Page({
  data: {
    active: true,
    cloudMode: false,
    chatTitle: '转接会话',
    routeHint: '消息会经转接人转给对方',
    inputText: "",
    sending: false,
    uploadingImage: false,
    scrollIntoView: "",
    messages: [
      { id: "seed-1", mine: true, sender: "我 · 发给接收方", text: "周六还按原计划吗？我看天气好像不错。", delivery: "已转接给接收方 · 09:41" },
      { id: "seed-2", mine: false, sender: "接收方 · 回复我", text: "按原计划！早上八点见，我把路线也整理好了。", relay: "经转接人转回 · 09:42" }
    ]
  },

  onLoad(options) {
    const app = getApp();
    const channelId = options.channelId || config.channelId;
    if (app.globalData.cloudReady && channelId) {
      this.channelId = channelId;
      this.role = options.role || config.role;
      wx.setNavigationBarTitle({ title: `${this.role === 'a' ? '发送方' : '接收方'} · 转接会话` });
      this._lastMessageAt = 0;
      this._seenMessageIds = new Set();
      const isSender = this.role === 'a';
      this.setData({
        cloudMode: true,
        messages: [],
        chatTitle: `${isSender ? '发送方' : '接收方'} · 转接会话`,
        routeHint: isSender ? '消息会经转接人转给接收方' : '消息会经转接人转给发送方'
      });
      this.refreshMessages();
    }
  },

  onShow() {
    if (this.data.cloudMode) this._pollTimer = setInterval(() => this.refreshMessages(), 4000);
  },

  onHide() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
  },

  onUnload() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  },

  refreshMessages() {
    if (!this.channelId || this._polling) return Promise.resolve();
    this._polling = true;
    return relayApi.listMessages(this.channelId, Math.max(0, (this._lastMessageAt || 0) - 1)).then((result) => {
      if (!result || !Array.isArray(result.messages)) {
        throw new Error('消息接口返回格式异常，请重新部署 relay 云函数');
      }
      this._lastRefreshError = '';
      const unseen = result.messages.filter((message) => message && message.id && !this._seenMessageIds.has(message.id));
      if (result.role === 'a' || result.role === 'c') this.role = result.role;
      const incoming = unseen.map((message) => {
        this._seenMessageIds.add(message.id);
        const mine = message.fromRole === this.role;
        const createdAt = Number(message.createdAt) || 0;
        this._lastMessageAt = Math.max(this._lastMessageAt || 0, createdAt);
        const counterpart = this.role === 'a' ? '接收方' : '发送方';
        return {
          id: message.id,
          mine,
          sender: mine ? `我 · 发给${counterpart}` : `${counterpart} · 经转接人转接`,
          text: message.text,
          imagePath: message.imageUrl,
          timeLabel: this.formatTime(createdAt),
          delivery: mine ? `已转接给${counterpart}` : '',
          relay: mine ? '' : '经转接人转回给你'
        };
      });
      this.setData({
        active: result.state === 'active',
        messages: this.data.messages.concat(incoming),
        scrollIntoView: incoming.length ? incoming[incoming.length - 1].id : this.data.scrollIntoView
      });
    }).catch((error) => {
      const message = error && (error.message || error.errMsg) || '读取消息失败';
      if (message !== this._lastRefreshError) this.toast(message);
      this._lastRefreshError = message;
    }).finally(() => { this._polling = false; });
  },

  onInput(event) {
    this.setData({ inputText: event.detail.value });
  },

  async sendText() {
    const text = (this.data.inputText || "").trim();
    if (!this.data.active) return this.toast("转接已暂停");
    if (!text || this.data.sending) return;
    if (this.data.cloudMode) {
      this.setData({ sending: true });
      try {
        await relayApi.sendText(this.channelId, text);
        this.setData({ inputText: '' });
        await this.refreshMessages();
      } catch (error) {
        this.toast(error && (error.message || error.errMsg) || '发送失败');
      } finally {
        this.setData({ sending: false });
      }
      return;
    }
    this.appendMessage({ mine: true, sender: "我 · 发给接收方", text, delivery: "已转接给接收方 · 刚刚" });
    this.setData({ inputText: "" });
    this.toast("演示：文字已转接");
  },

  chooseImage() {
    if (!this.data.active) return this.toast("转接已暂停");
    if (this.data.uploadingImage) return;
    const openPicker = () => wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (result) => {
        const file = result.tempFiles && result.tempFiles[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) return this.toast("图片需小于 10 MB");
        if (this.data.cloudMode) {
          const extension = (file.tempFilePath.split('.').pop() || 'jpg').toLowerCase();
          this.setData({ uploadingImage: true });
          relayApi.prepareImageUpload(this.channelId, extension).then(({ uploadPath }) =>
            wx.cloud.uploadFile({ cloudPath: uploadPath, filePath: file.tempFilePath })
              .then(({ fileID }) => relayApi.registerImageUpload(this.channelId, uploadPath, fileID).then(() => ({ uploadPath, fileID })))
          ).then(({ uploadPath, fileID }) => relayApi.sendImage(this.channelId, uploadPath, fileID))
            .then(() => this.refreshMessages())
            .catch((error) => this.toast(error && (error.message || error.errMsg) || '图片发送失败'))
            .finally(() => this.setData({ uploadingImage: false }));
          return;
        }
        this.appendMessage({
          mine: true,
          sender: "我 · 图片发给接收方",
          imagePath: file.tempFilePath,
          delivery: "图片已转接给接收方 · 刚刚"
        });
        this.toast("演示：图片已转接（仅本机预览）");
      },
      fail: (error) => {
        if (error && error.errMsg && !error.errMsg.includes("cancel")) this.toast("无法打开相册，请重试");
      }
    });
    if (typeof wx.requirePrivacyAuthorize === 'function') {
      wx.requirePrivacyAuthorize({ success: openPicker, fail: () => {} });
      return;
    }
    openPicker();
  },

  simulateReply() {
    if (!this.data.active) return this.toast("请先重新开启转接");
    if (this.data.cloudMode) return this.toast('真实会话中请等待对方回复');
    this.appendMessage({
      mine: false,
      sender: "接收方 · 回复我",
      text: "收到啦，我看到了，周六见！",
      relay: "经转接人转回 · 刚刚"
    });
    this.toast("演示：对方的回复已转回给你");
  },

  previewImage(event) {
    const current = event.currentTarget.dataset.src;
    if (!current) return;
    const urls = this.data.messages.filter((message) => message.imagePath).map((message) => message.imagePath);
    wx.previewImage({ current, urls });
  },

  toggleRelay() {
    if (this.data.cloudMode) return this.toast('请由转接人管理转接规则');
    const active = !this.data.active;
    this.setData({ active });
    this.toast(active ? "转接已开启" : "转接已暂停");
  },

  appendMessage(message) {
    const id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.setData({
      messages: [...this.data.messages, { id, ...message }],
      scrollIntoView: id
    });
  },

  formatTime(timestamp) {
    const date = new Date(timestamp);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  },

  toast(title) {
    wx.showToast({ title, icon: "none", duration: 1800 });
  }
});
