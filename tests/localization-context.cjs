const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../thunder-g/localization.js'),'utf8');
exports.createContext=extra=>{const scope=vm.createContext(extra);vm.runInContext(source,scope);return scope};
