const config = require('./config');

App({
  globalData: { cloudReady: false, relayConfig: config },
  onLaunch() {
    if (!config.envId || !wx.cloud) return;
    wx.cloud.init({ env: config.envId, traceUser: true });
    this.globalData.cloudReady = true;
  }
});
