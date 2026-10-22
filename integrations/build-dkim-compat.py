"""Build the explicit local DKIM 6.4.0 compatibility patch from a pristine XPI."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json, sys
source, target = map(Path, sys.argv[1:])
root = Path(__file__).resolve().parent
with ZipFile(source) as archive, ZipFile(target, 'w', ZIP_DEFLATED) as output:
    manifest = json.loads(archive.read('manifest.json'))
    assert manifest['version'] == '6.4.0', 'Review compatibility with this DKIM Verifier version first'
    for item in archive.infolist():
        data = archive.read(item.filename)
        if item.filename == 'content/background.mjs.js':
            text = data.decode()
            assert 'thunderGPopupMessages' not in text, 'Use a pristine provider archive'
            needle = 'async function verifyMessage(tabId, message) {'
            assert text.count(needle) == 1
            text = text.replace(needle, needle + '''
    if(tabId < -1000) {
        const result=await verifier.verify(message);
        if(thunderGPopupMessages.has(tabId))displayedResultsCache.set(tabId,result);
        return;
    }
''')
            assert text.count('await browser.messageDisplay.getDisplayedMessage(tabId)') == 4
            text = text.replace('await browser.messageDisplay.getDisplayedMessage(tabId)', 'await thunderGDisplayedMessage(tabId)')
            text = text.replace('browser.dkimHeader.reset(tabId, message.id);', 'if(tabId >= -1000)browser.dkimHeader.reset(tabId, message.id);')
            data = text.encode() + b'\n' + (root/'bimi-lookup.js').read_bytes() + b'\n' + (root/'dkim-thunderg-bridge.js').read_bytes()
        elif item.filename == 'content/displayAction.mjs.js':
            text = data.decode()
            needle = 'async function getCurrentTabId() {'
            assert text.count(needle) == 1
            text = text.replace(needle, needle + '''
    const context=Number(new URL(location.href).searchParams.get('thunderGContext'));
    if(Number.isInteger(context) && context < -1000)return context;
''')
            data = text.encode()
        output.writestr(item, data)
print(target)
