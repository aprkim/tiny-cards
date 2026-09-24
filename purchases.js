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

  /* Web Billing (RevenueCat, Stripe underneath). Two facts make this small:
     the checkout page is hosted by RevenueCat, and its events arrive at the
     same revenuecatWebhook that already serves the App Store — store
     RC_BILLING maps to unlimitedSource 'stripe'. So nothing new writes to
     Firestore, and the plan watch below lights the app up the moment the
     webhook lands, with no polling and no return-URL handshake.

     The link is public by design (it is a payment page, not a credential), so
     it lives here rather than in the build's key file, which kept.cards does
     not serve anyway. Appending the Firebase uid is what makes the purchase
     land on the right account: RevenueCat takes the last path segment as the
     app_user_id, exactly as the native SDK is configured to. Leave either
     blank and the web simply falls back to pointing at the iPhone. */
  /* Empty on purpose: the dashboard side is built and proven, but the only
     link that exists is a SANDBOX one, which grants Kept Unlimited without
     charging anything. Empty means canBuyWeb() is false and the web falls
     back to naming the iPhone — today's behaviour, with the whole path ready
     behind it. Paste the production link here once a real payment account is
     connected, and web selling turns on with no other change. */
  var WEB_CHECKOUT='';
  var WEB_PORTAL='';     // its customer portal link, for cancelling on the web
  // These hold the real links: kept.cards serves this file straight out of the
  // repo, with no build step to inject anything. The NATIVE build is what
  // removes them (scripts/strip-web-checkout.js), so the iOS bundle ships with
  // no payment URL in it. That script also refuses to build if a payment host
  // survives anywhere in the file, which is why none is written out even in a
  // comment.

  function userNow(){
    try{return firebase.auth().currentUser||null;}catch(e){return null;}
  }
  /* '' when the web cannot sell right now — not configured, or not signed in.
     The uid is a path segment, which is the format RevenueCat reads as the
     app_user_id; email only prefills the payment page, and is left off when we
     do not have one rather than sending an empty parameter. */
  function webCheckoutUrl(){
    var u=userNow();
    if(native||!WEB_CHECKOUT||!u||!u.uid)return '';
    var url=WEB_CHECKOUT.replace(/\/+$/,'')+'/'+encodeURIComponent(u.uid);
    if(u.email)url+='?email='+encodeURIComponent(u.email);
    return url;
  }
  function canBuyWeb(){return !!webCheckoutUrl();}
  /* Same tab, not a new one: a popup here is blocked as often as not, and
     coming back to a tab that already holds the archive is the calmer return.
     Nothing is lost by leaving — the card being saved is a draft in Firestore
     already, and the entitlement arrives by webhook regardless of where the
     browser ends up. */
  function buyWeb(){
    var url=webCheckoutUrl();
    if(!url)return false;
    window.location.href=url;
    return true;
  }
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
        // isUnlimited is the live subscription; unlimitedGrant is permanent
        // (early users, comped accounts) and survives a lapse. Either counts.
        var p=d.exists?d.data():null;
        storeUnlimited=!!(p&&(p.isUnlimited===true||p.unlimitedGrant===true));
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
    // A web subscriber has no Apple subscription to open, and sending them to
    // one would be a dead end wearing a helpful face.
    if(!native)return Promise.resolve(WEB_PORTAL?window.open(WEB_PORTAL,'_blank'):null);
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
                        restore:restore,manage:manage,native:native,
                        canBuyWeb:canBuyWeb,buyWeb:buyWeb,webPortal:function(){return WEB_PORTAL;}};
})();
