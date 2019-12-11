'use strict';
var EventEmitter = require('events');
var helpers = require('./helpers');
var collate = require('pouchdb-collate').collate;
var selectorCore = require('pouchdb-selector-core');
var utils = require('./utils');
var getValue = selectorCore.getValue;
var massageSelector = selectorCore.massageSelector;
var massageSort = utils.massageSort;

function liveFind(db, requestDef) {
    if (typeof db.find !== 'function') {
        throw new Error(
            'ERROR: PouchDB Find is a requirement for LiveFind and must be loaded first.'
        );
    }

    //var db = this;
    var cancelled = false;
    var lookup = {};
    var emitter = new EventEmitter();
    var docList2 = [];    
    var aggregate = requestDef.aggregate || false;

    // Normalize the request options
    var fields = requestDef.fields;
    var stripId = false,
        stripRev = false;
    if (fields) {
        // _id is a necessary field to process the docs
        if (fields.indexOf('_id') === -1) {
            fields.unshift('_id');
            stripId = true;
        }
        // We need the _rev to sort out changes but can strip it later
        if (fields.indexOf('_rev') === -1) {
            fields.push('_rev');
            stripRev = true;
        }
    }
    var selector;
    if (requestDef.selector) {
        selector = massageSelector(requestDef.selector);
    }
    var sort, sortFn;
    if (requestDef.sort) {
        sort = massageSort(requestDef.sort);
        sortFn = helpers.createFieldSorter(sort);
    }
    var skip = parseInt(requestDef.skip, 10) || 0;
    var limit = parseInt(requestDef.limit, 10) || 0;
    var findRequest = {
        selector: selector,
        // sort: sort,
        fields: fields,
    };

    var ready = db
        .find(findRequest)
        .then(function(results) {
            results.docs.forEach(function(doc) {
                addResult(doc);
            });
            emitter.emit('ready');
        })
        .catch(function(err) {
            emitter.emit('error', err);
            cancel();
            throw err;
        });

    // We will use just one change listener for all live queries.
    // We need to keep track of how many queries are running.
    // When the last live query finishes we will cancel the listener.
    if (!db._changeListener) {
        listen();
    }
    if (!db._activeQueries) {
        db._activeQueries = 1;
    } else {
        db._activeQueries++;
    }

    db._changeListener.on('change', changeHandler).on('error', errorHandler);

    emitter.cancel = cancel;
    // Bind the `find` query promise to our emitter object
    // so we know when the initial query is done and can catch errors
    emitter.then = ready.then.bind(ready);
    emitter.catch = ready.catch.bind(ready);

    emitter.sort = function(list) {
        if (!sort) {
            return list;
        }
        return sortList(list);
    };

    emitter.paginate = paginate;

    function changeHandler(change) {
        ready.then(function() {
            if (change.doc) {
                processChange(change.doc);
            }
        });
    }

    function errorHandler(err) {
        emitter.emit('error', err);
    }

    function cancel() {
        console.log(emitter.eventNames());
        console.log('Max listeners: ', emitter.getMaxListeners());
        if (!cancelled) {
            db._activeQueries--;
            if (!db._activeQueries) {
                db._changeListener.cancel();
                delete db._changeListener;
            } else {
                db._changeListener.removeListener('change', changeHandler);
                db._changeListener.removeListener('error', errorHandler);
            }
            emitter.emit('cancelled');
            emitter.removeAllListeners();
            cancelled = true;
        }
    }

    function listen() {
        db._changeListener = db.changes({
            live: true,
            retry: true,
            include_docs: true,
            since: 'now',
        });
    }

    // This processes the initial results of the query
    function addResult2(doc) {
      //lookup[doc._id] = doc._rev;
      var id = doc._id;
      var rev = doc._rev;
      if (stripId) {
          delete doc._id;
      }
      if (stripRev) {
          delete doc._rev;
      }
      return addAction2(doc, id, rev);
  }

    function processChange(doc) {
        // Don't fire an update if this rev has already been processed
        if (lookup[doc._id] === doc._rev) {
            // console.warn('A change was fired twice. This shouldn\'t happen.');
            return;
        }
        var id = doc._id;
        var rev = doc._rev;

        // just use find
        console.time('RegularFind')

        db
        .find(findRequest)
        .then(function(results) {
            // clear docList2 and create a new array
            docList2 = [];    
            results.docs.forEach(function(doc) {
                addResult2(doc);
            });
            emitter.emit('ready');
        })
        .catch(function(err) {
            emitter.emit('error', err);
            cancel();
            throw err;
        });

        console.timeEnd('RegularFind')
    }

    function addAction2(doc, id, rev) {
      var list;
      if (aggregate) {
          docList2 = docList2.concat(doc);
          list = formatList(docList2);
      }
      emitter.emit(
          'update',
          { action: 'ADD', id: id, rev: rev, doc: doc },
          list
      );
  }

    function sortList(list) {
        return list.sort(sortFn);
    }

    // Applies sort, skip, and limit to a list
    function formatList(list) {
        if (sort) {
            list = sortList(list);
        }
        if (skip || limit) {
            if (limit) {
                list = list.slice(skip, skip + limit);
            } else {
                list = list.slice(skip);
            }
        }
        return list;
    }

    function paginate(options) {
        if (!aggregate || !options || typeof options !== 'object') {
            return;
        }
        if (options.skip != null) {
            skip = parseInt(options.skip, 10) || 0;
        }
        if (options.limit != null) {
            limit = parseInt(options.limit, 10) || 0;
        }
        if (options.sort && options.sort instanceof Array) {
            sort = massageSort(options.sort);
            sortFn = helpers.createFieldSorter(sort);
        }
        return formatList(docList2);
    }

    return emitter;
}

exports.liveFind = liveFind;
