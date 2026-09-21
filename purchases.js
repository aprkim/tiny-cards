/* Kept Plus — RevenueCat on iOS, in one place.

   Both tab pages (cards.html, scan.html) load this before their own script and
   call KeptPurchases.init() once Firebase is up. On the web there is no
   Capacitor, so every store call is a no-op and only the plan watch runs.

   Two facts, kept apart on purpose:
   - isPlus() is what the app gates on. It comes from users/{uid}.isPlus in
     Firestore (written by functions and, next, the store webhook; the client
     never writes it), OR'd with a session-only flag set the moment a purchase
     or restore succeeds so the UI doesn't lag the receipt.
   - getEntitlement() is RevenueCat's own view (customerInfo.entitlements.active),
     for that optimistic moment only, never for the gate.

   The RevenueCat app_user_id is always the Firebase uid: configure() runs on
   the first auth event with that uid, and later sign-ins/outs call
   logIn/logOut. The public SDK key comes from rc-config.js, which the build
   writes into www/ from REVENUECAT_IOS_KEY; it is never in the repo and never
   requested on the web. */
(function(){
  var ENTITLEMENT='unlimited';
  var native=!!(window.Capacitor&&typeof window.Capacitor.isNativePlatform==='function'&&window.Capacitor.isNativePlatform());
  function plugin(n){return (native&&window.Capacitor.Plugins&&window.Capacitor.Plugins[n])||null;}
  function warn(){if(window.console)console.warn.apply(console,['purchases:'].concat([].slice.call(arguments)));}

  var configured=null;    // Promise<boolean>: SDK configured with the signed-in uid
  var storePlus=false;    // users/{uid}.isPlus — the source of truth
  var sessionPlus=false;  // just bought/restored in this session (optimistic)
  var started=false, unsubPlan=null, watchers=[];

  function isPlus(){return storePlus||sessionPlus;}
  function notify(){watchers.forEach(function(f){try{f(isPlus());}catch(e){}});}
  function onChange(f){watchers.push(f);}

  // Plan watch: live, so a webhook write (later) or a restore on another device
  // shows up without a relaunch. A missing doc, or no read permission, is free.
  function watchPlan(uid){
    if(unsubPlan){unsubPlan();unsubPlan=null;}
    storePlus=false;sessionPlus=false;
    if(uid){
      unsubPlan=firebase.firestore().collection('users').doc(uid).onSnapshot(function(d){
        storePlus=!!(d.exists&&d.data().isPlus===true);notify();
      },function(e){storePlus=false;warn('plan watch',e&&e.code);notify();});
    }
    notify();
  }

  // The key ships as www/rc-config.js (build output, never on the web site).
  function loadKey(){
    return new Promise(function(res){
      if(window.RC_IOS_KEY)return res(window.RC_IOS_KEY);
      var s=document.createElement('script');s.src='rc-config.js';
      s.onload=function(){res(window.RC_IOS_KEY||'');};s.onerror=function(){res('');};
      document.head.appendChild(s);
    });
  }
  function configure(uid){
    var P=plugin('Purchases');
    return loadKey().then(function(key){
      if(!key){warn('no SDK key (rc-config.js missing) — purchases disabled');return false;}
      return P.isConfigured().then(function(r){
        if(r&&r.isConfigured)return uid?P.logIn({appUserID:uid}).then(function(){return true;}):true;
        var o={apiKey:key};if(uid)o.appUserID=uid;
        return P.configure(o).then(function(){return true;});
      });
    }).catch(function(e){warn('configure failed',e);return false;});
  }

  function init(){
    if(started)return;started=true;
    firebase.auth().onAuthStateChanged(function(u){
      var uid=u?u.uid:null;
      watchPlan(uid);
      if(!plugin('Purchases'))return;                                  // web: nothing to configure
      if(!configured){configured=configure(uid);return;}
      configured.then(function(ok){
        if(!ok)return;
        var P=plugin('Purchases');
        if(uid)P.logIn({appUserID:uid}).catch(function(e){warn('logIn',e);});
        else P.logOut().catch(function(){});                            // already anonymous = fine
      });
    });
  }

  function hasEntitlement(info){
    var a=info&&info.entitlements&&info.entitlements.active;
    return !!(a&&a[ENTITLEMENT]);
  }
  function ready(){return configured?configured:Promise.resolve(false);}

  // RevenueCat's own answer: the active entitlements map (empty when unknown).
  function getEntitlement(){
    return ready().then(function(ok){
      if(!ok)return {};
      return plugin('Purchases').getCustomerInfo().then(function(r){
        return (r&&r.customerInfo&&r.customerInfo.entitlements&&r.customerInfo.entitlements.active)||{};
      });
    }).catch(function(e){warn('customerInfo',e);return {};});
  }

  // Hosted paywall for the default offering. Resolves true only on PURCHASED or
  // RESTORED. CANCELLED (the user closed the sheet) is a normal outcome and
  // resolves false with no message; the sheet itself reports store errors.
  function showPaywall(){
    var UI=plugin('RevenueCatUI');
    return ready().then(function(ok){
      if(!ok||!UI)return false;
      return UI.presentPaywall({displayCloseButton:true}).then(function(r){
        var res=(r&&r.result)||'';
        if(res==='PURCHASED'||res==='RESTORED'){sessionPlus=true;notify();return true;}
        if(res!=='CANCELLED')warn('paywall result',res);
        return false;
      });
    }).catch(function(e){warn('paywall',e);return false;});
  }

  // Restore Purchases (App Review requires it). Resolves true if the
  // entitlement is active for this Apple ID; rejects on a store/network error.
  function restore(){
    return ready().then(function(ok){
      if(!ok)throw new Error('purchases unavailable');
      return plugin('Purchases').restorePurchases().then(function(r){
        var plus=hasEntitlement(r&&r.customerInfo);
        if(plus){sessionPlus=true;notify();}
        return plus;
      });
    });
  }

  // Apple's subscription management page for this account.
  function manage(){
    var apple='https://apps.apple.com/account/subscriptions';
    return ready().then(function(ok){
      if(!ok)return apple;
      return plugin('Purchases').getCustomerInfo().then(function(r){
        return (r&&r.customerInfo&&r.customerInfo.managementURL)||apple;
      }).catch(function(){return apple;});
    }).then(function(url){window.open(url,'_blank');});
  }

  window.KeptPurchases={init:init,isPlus:isPlus,onChange:onChange,getEntitlement:getEntitlement,
                        showPaywall:showPaywall,restore:restore,manage:manage,native:native};
})();
