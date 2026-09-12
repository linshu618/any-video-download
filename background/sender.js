export function isExtensionPage(sender,id) {
  if(sender.id!==id)return false;
  const origin=`chrome-extension://${id}`;
  if(sender.url) {
    try {const u=new URL(sender.url);return u.protocol==='chrome-extension:' && u.hostname===id;} catch{return false;}
  }
  if(sender.origin)return sender.origin===origin;
  // A content-script sender always has a tab; background/extension-only callers may omit URL.
  return !sender.tab;
}
