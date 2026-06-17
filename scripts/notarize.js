'use strict';

const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
    const { electronPlatformName, appOutDir } = context;
    if (electronPlatformName !== 'darwin') { return; }
    if (process.env.SKIP_NOTARIZE === '1') { console.log('→ Skipping notarization (local build).'); return; }

    const appName = context.packager.appInfo.productFilename;
    const appPath = `${appOutDir}/${appName}.app`;

    console.log(`→ Notarizing ${appPath}…`);
    await notarize({
        tool: 'notarytool',
        appPath,
        keychainProfile: 'notarytool-profile',
    });
    console.log('→ Notarization done.');
};
