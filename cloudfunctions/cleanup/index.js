const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async () => {
  const now = Date.now();
  const batchSize = 100;
  const maxBatches = 5;
  let expiredMessages = 0;
  let expiredUploads = 0;
  let batchLimitReached = false;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const [expired, oldUploads] = await Promise.all([
      db.collection('relayMessages').where({ expiresAt: _.lte(now) }).limit(batchSize).get(),
      db.collection('relayUploads').where({ expiresAt: _.lte(now) }).limit(batchSize).get()
    ]);
    if (!expired.data.length && !oldUploads.data.length) break;

    const fileIDs = [...new Set([
      ...expired.data.map((item) => item.fileID),
      ...oldUploads.data.map((item) => item.fileID)
    ].filter(Boolean))];
    for (let i = 0; i < fileIDs.length; i += 50) {
      await cloud.deleteFile({ fileList: fileIDs.slice(i, i + 50) });
    }
    const docsToRemove = [
      ...expired.data.map((item) => ({ collection: 'relayMessages', id: item._id })),
      ...oldUploads.data.map((item) => ({ collection: 'relayUploads', id: item._id }))
    ];
    for (let i = 0; i < docsToRemove.length; i += 20) {
      await Promise.all(docsToRemove.slice(i, i + 20).map(({ collection, id }) => db.collection(collection).doc(id).remove()));
    }
    expiredMessages += expired.data.length;
    expiredUploads += oldUploads.data.length;
    if (batch === maxBatches - 1) batchLimitReached = true;
  }
  return { expiredMessages, expiredUploads, batchLimitReached };
};
