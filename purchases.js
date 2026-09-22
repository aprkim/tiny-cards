/* Kept Unlimited — RevenueCat on iOS, in one place.

   Both tab pages (cards.html, scan.html) load this before their own script and
   call KeptPurchases.init() once Firebase is up. On the web there is no
   Capacitor, so every store call is a no-op and only the plan watch runs.

   Two facts, kept apart on purpose:
   - isUnlimited() is what the app gates on. It comes from users/{uid}.isUnlimited in
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

  var configured=null;    // Promise<string>: '' once the SDK is configured, else why not
  var storeUnlimited=false;    // users/{uid}.isUnlimited — the source of truth
  var sessionUnlimited=false;  // just bought/restored in this session (optimistic)
  var started=false, unsubPlan=null, watchers=[];
  var planError='';      // why the plan could not be read (offline, rules, no doc yet)

  function isUnlimited(){return storeUnlimited||sessionUnlimited;}
  function notify(){watchers.forEach(function(f){try{f(isUnlimited());}catch(e){}});}
  function onChange(f){watchers.push(f);}

  // Plan watch: live, so a webhook write (later) or a restore on another device
  // shows up without a relaunch. A missing doc, or no read permission, is free.
  function watchPlan(uid){
    if(unsubPlan){unsubPlan();unsubPlan=null;}
    storeUnlimited=false;sessionUnlimited=false;
    planError=uid?'reading\u2026':'';
    if(uid){
      unsubPlan=firebase.firestore().collection('users').doc(uid).onSnapshot(function(d){
        storeUnlimited=!!(d.exists&&d.data().isUnlimited===true);
        planError=d.exists?'':'no plan record yet';
        notify();
      },function(e){
        storeUnlimited=false;planError=(e&&(e.code||e.message))||'unavailable';
        warn('plan watch',planError);notify();
      });
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
  /* Resolves '' when the SDK is ready, otherwise a short reason. Returning the
     reason rather than a boolean is the difference between "the button does
     nothing" and knowing which piece is missing — on a device there is no
     console to check. */
  function configure(uid){
    var P=plugin('Purchases');
    return loadKey().then(function(key){
      if(!key)return 'key file missing';
      return P.isConfigured().then(function(r){
        if(r&&r.isConfigured)return uid?P.logIn({appUserID:uid}).then(function(){return '';}):'';
        /* configure() is declared CAPPluginReturnNone on the native side: it
           returns undefined, not a promise, so it cannot be chained. It applies
           synchronously, and isConfigured() is how we confirm it took. */
        var o={apiKey:key};if(uid)o.appUserID=uid;
        P.configure(o);
        return P.isConfigured().then(function(r2){
          return (r2&&r2.isConfigured)?'':'configure had no effect';
        });
      });
    }).catch(function(e){
      warn('configure failed',e);
      return 'sdk: '+((e&&(e.message||e.code))||'unknown');
    });
  }

  function init(){
    if(started)return;started=true;
    firebase.auth().onAuthStateChanged(function(u){
      var uid=u?u.uid:null;
      watchPlan(uid);
      if(!plugin('Purchases'))return;                                  // web: nothing to configure
      if(!configured){configured=configure(uid);return;}
      configured.then(function(why){
        if(why)return;
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
  // '' when usable; a reason when not (including before init() has run).
  function ready(){return configured?configured:Promise.resolve('init not run');}

  // RevenueCat's own answer: the active entitlements map (empty when unknown).
  function getEntitlement(){
    return ready().then(function(why){
      if(why)return {};
      return plugin('Purchases').getCustomerInfo().then(function(r){
        return (r&&r.customerInfo&&r.customerInfo.entitlements&&r.customerInfo.entitlements.active)||{};
      });
    }).catch(function(e){warn('customerInfo',e);return {};});
  }

  /* Hosted paywall for the default offering. Resolves the outcome as a string
     rather than a boolean, because every way this can fail is invisible to the
     user otherwise: a tap that opens nothing is indistinguishable from a broken
     button. bought() and explain() turn the string into a decision and a
     sentence; CANCELLED is the one non-success that stays silent. */
  function showPaywall(){
    var UI=plugin('RevenueCatUI');
    return ready().then(function(why){
      if(why)return 'NOT_CONFIGURED: '+why;
      if(!UI)return 'NO_UI_PLUGIN';
      return UI.presentPaywall({displayCloseButton:true}).then(function(r){
        var res=(r&&r.result)||'UNKNOWN';
        if(bought(res)){sessionUnlimited=true;notify();}
        if(res!=='CANCELLED')warn('paywall result',res);
        return res;
      });
    }).catch(function(e){
      warn('paywall',e);
      return 'ERROR: '+((e&&(e.message||e.code))||'unknown');
    });
  }
  function bought(res){return res==='PURCHASED'||res==='RESTORED';}
  // null when there is nothing to say (bought, or closed on purpose).
  function explain(res){
    if(bought(res)||res==='CANCELLED')return null;
    if(res.indexOf('NOT_CONFIGURED')===0)return 'Purchases aren\u2019t set up in this build yet \u2014 '+res.slice(17)+'.';
    if(res==='NO_UI_PLUGIN')return 'This build is missing the paywall component.';
    if(res==='NOT_PRESENTED')return 'There\u2019s no paywall configured for Kept yet, so there is nothing to show.';
    return 'The subscription screen couldn\u2019t open ('+res+').';
  }

  // Restore Purchases (App Review requires it). Resolves true if the
  // entitlement is active for this Apple ID; rejects on a store/network error.
  function restore(){
    return ready().then(function(why){
      if(why)throw new Error('purchases unavailable: '+why);
      return plugin('Purchases').restorePurchases().then(function(r){
        var plus=hasEntitlement(r&&r.customerInfo);
        if(plus){sessionUnlimited=true;notify();}
        return plus;
      });
    });
  }

  // Apple's subscription management page for this account.
  function manage(){
    var apple='https://apps.apple.com/account/subscriptions';
    return ready().then(function(why){
      if(why)return apple;
      return plugin('Purchases').getCustomerInfo().then(function(r){
        return (r&&r.customerInfo&&r.customerInfo.managementURL)||apple;
      }).catch(function(){return apple;});
    }).then(function(url){window.open(url,'_blank');});
  }

  function planStatus(){return planError;}
  window.KeptPurchases={init:init,isUnlimited:isUnlimited,planStatus:planStatus,onChange:onChange,getEntitlement:getEntitlement,
                        showPaywall:showPaywall,bought:bought,explain:explain,
                        restore:restore,manage:manage,native:native};
})();
