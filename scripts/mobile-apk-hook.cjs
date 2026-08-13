'use strict';

const { verifyDist } = require('./mobile-apk.cjs');

exports.default = async function verifyMobileReleaseBeforePack() {
  verifyDist({ requireRelease: true });
};
