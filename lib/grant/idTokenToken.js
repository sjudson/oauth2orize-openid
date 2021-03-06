/**
 * Module dependencies.
 */
var merge = require('utils-merge')
  , AuthorizationError = require('oauth2orize').AuthorizationError;


/**
 * Handles requests to obtain a response with an access token and ID token.
 *
 * References:
 *  - [OpenID Connect Standard 1.0 - draft 21](http://openid.net/specs/openid-connect-standard-1_0.html)
 *  - [OpenID Connect Messages 1.0 - draft 20](http://openid.net/specs/openid-connect-messages-1_0.html)
 *  - [OAuth 2.0 Multiple Response Type Encoding Practices - draft 08](http://openid.net/specs/oauth-v2-multiple-response-types-1_0.html)
 *
 * @param {Object} options
 * @param {Function} issue
 * @return {Object} module
 * @api public
 */
module.exports = function(options, issueToken, issueIDToken) {
  if (typeof options == 'function') {
    issueIDToken = issueToken;
    issueToken = options;
    options = undefined;
  }
  options = options || {};
  
  if (!issueToken) throw new TypeError('oauth2orize-openid.idTokenToken grant requires an issueToken callback');
  if (!issueIDToken) throw new TypeError('oauth2orize-openid.idTokenToken grant requires an issueIDToken callback');

  var modes = options.modes || {};
  if (!modes.fragment) {
    modes.fragment = require('../response/fragment');
  }

  // For maximum flexibility, multiple scope spearators can optionally be
  // allowed.  This allows the server to accept clients that separate scope
  // with either space or comma (' ', ',').  This violates the specification,
  // but achieves compatibility with existing client libraries that are already
  // deployed.
  var separators = options.scopeSeparator || ' ';
  if (!Array.isArray(separators)) {
    separators = [ separators ];
  }
  
  
  /* Parse requests that request `id_token token` as `response_type`.
   *
   * @param {http.ServerRequest} req
   * @api public
   */
  function request(req) {
    var clientID = req.query['client_id']
      , redirectURI = req.query['redirect_uri']
      , scope = req.query['scope']
      , state = req.query['state'];
      
    if (!clientID) { throw new AuthorizationError('Missing required parameter: client_id', 'invalid_request'); }
    if (typeof clientID !== 'string') { throw new AuthorizationError('Invalid parameter: client_id must be a string', 'invalid_request'); }
    
    if (scope) {
      if (typeof scope !== 'string') {
        throw new AuthorizationError('Invalid parameter: scope must be a string', 'invalid_request');
      }
      
      for (var i = 0, len = separators.length; i < len; i++) {
        var separated = scope.split(separators[i]);
        // only separate on the first matching separator.  this allows for a sort
        // of separator "priority" (ie, favor spaces then fallback to commas)
        if (separated.length > 1) {
          scope = separated;
          break;
        }
      }
      
      if (!Array.isArray(scope)) { scope = [ scope ]; }
    }
    
    return {
      clientID: clientID,
      redirectURI: redirectURI,
      scope: scope,
      state: state
    }
  }
  
  /* Sends responses to transactions that request `id_token token` as `response_type`.
   *
   * @param {Object} txn
   * @param {http.ServerResponse} res
   * @param {Function} next
   * @api public
   */
  function response(txn, res, next) {
    var mode = 'fragment'
      , respond;

    if (txn.req && txn.req.responseMode) {
      mode = txn.req.responseMode;
    }
    respond = modes[mode];
    
    if (!respond) {
      // http://lists.openid.net/pipermail/openid-specs-ab/Week-of-Mon-20140317/004680.html
      return next(new AuthorizationError('Unsupported response mode: ' + mode, 'unsupported_response_mode', null, 501));
    }
    if (respond && respond.validate) {
      try {
        respond.validate(txn);
      } catch(ex) {
        return next(ex);
      }
    }

    if (!txn.res.allow) {
      var params = { error: 'access_denied' };
      if (txn.req && txn.req.state) { params.state = txn.req.state; }
      return respond(txn, res, params);
    }
    
    function doIssueIDToken(tok) {
      function issued(err, idToken) {
        if (err) { return next(err); }
        if (!idToken) { return next(new AuthorizationError('Request denied by authorization server', 'access_denied')); }
      
        tok['id_token'] = idToken;
        if (txn.req && txn.req.state) { tok['state'] = txn.req.state; }

        return respond(txn, res, tok);
      }
    
      try {
        // NOTE: To facilitate code reuse, the `issueIDToken` callback should
        //       interoperate with the `issue` callback implemented by
        //       `oauth2orize-openid.grant.idToken`.
        
        var arity = issueIDToken.length;
        if (arity == 7) {
          issueIDToken(txn.client, txn.user, txn.res, txn.req, { accessToken: tok.access_token }, txn.locals, issued);
        } else if (arity == 6) {
          issueIDToken(txn.client, txn.user, txn.res, txn.req, { accessToken: tok.access_token }, issued);
        } else if (arity == 5) {
          issueIDToken(txn.client, txn.user, txn.res, txn.req, issued);
        } else { // arity == 4
          issueIDToken(txn.client, txn.user, txn.req, issued);
        }
      } catch (ex) {
        return next(ex);
      }
    }
    
    function doIssueToken() {
      function issued(err, accessToken, params) {
        if (err) { return next(err); }
        if (!accessToken) { return next(new AuthorizationError('Request denied by authorization server', 'access_denied')); }
      
        var tok = {};
        tok['access_token'] = accessToken;
        if (params) { merge(tok, params); }
        tok['token_type'] = tok['token_type'] || 'Bearer';
        if (txn.req && txn.req.state) { tok['state'] = txn.req.state; }
        
        doIssueIDToken(tok);
      }
      
      try {
        // NOTE: To facilitate code reuse, the `issueToken` callback should
        //       interoperate with the `issue` callback implemented by
        //       `oauth2orize.grant.token`.
        
        var arity = issueToken.length;
        if (arity == 6) {
          issueToken(txn.client, txn.user, txn.res, txn.req, txn.locals, issued);
        } else if (arity == 5) {
          issueToken(txn.client, txn.user, txn.res, txn.req, issued);
        } else if (arity == 4) {
          issueToken(txn.client, txn.user, txn.res, issued);
        } else { // arity == 3
          issueToken(txn.client, txn.user, issued);
        }
      } catch (ex) {
        return next(ex);
      }
    }
    
    doIssueToken();
  }
  
  
  /**
   * Return `id_token token` grant module.
   */
  var mod = {};
  mod.name = 'id_token token';
  mod.request = request;
  mod.response = response;
  return mod;
}
