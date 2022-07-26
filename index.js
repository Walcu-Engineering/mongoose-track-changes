const util = require('util');
const { EventEmitter } = require('events');

class CustomEmmiter extends EventEmitter {};

const getPathValue = (doc, path = '') => path.split('/').filter(p => p).reduce((subpath_part_value, subpath_part, i, path_array) => {
  if(subpath_part_value == null){
    if(i < path_array.length - 1) return {};
    return subpath_part_value;
  }
  return subpath_part_value[subpath_part];
}, doc);

const isAncestor = (path1, path2) => {
  const path1_parts = path1.split('/').slice(1);
  const path2_parts = path2.split('/').slice(1);
  return path1_parts.every((path1_part, i) => path2_parts[i] === path1_part);
}

const undo = (doc, change) => {
  if(change.path === ''){
    return change.old_value;
  }else{
    const [, change_first_path_part, ...rest_path_parts ] = change.path.split('/');
    if(doc && (doc.schema || doc.constructor.name === 'Object')){//Under this reverted types we have to go deeper with the recursion
      return (doc.schema && Object.values(doc.schema.paths).map(schema => [schema.path, doc.get(schema.path)])
        || doc.constructor.name === 'Object' && Object.entries(doc)
      ).map(([key, value]) => {
        if(change_first_path_part === key){//This change affects to this key, so we go deep inside
          const rerooted_change_pointer = rest_path_parts.join('/'); //if the rerooted change's path is the empty string, we don't want the path to be /.
          const rerooted_change = {path: rerooted_change_pointer.length > 0 ? `/${rerooted_change_pointer}` : rerooted_change_pointer, old_value: change.old_value};
          return [key, undo(value, rerooted_change)];
        }else{//This change does not affect to this object key, so we return the current document key value
          return [key, value];
        }
      }).reduce((c, n) => {
        c[n[0]] = n[1]; //we use this notation instead of ({...c, ...n}) because it is cheaper in the consumption of resources, and we want to be the fastest we can.
        return c;
      }, {});
    }else if(doc instanceof Array){
      return doc.map((value, index) => {//Here the index will be the first path part from the change's path.
        if(change_first_path_part === String(index)){//This change affects to this item, so we have to go deeper over this item
          const rerooted_change_pointer = rest_path_parts.join('/'); //if the rerooted change's path is the empty string, we don't want the path to be /.
          const rerooted_change = {path: rerooted_change_pointer.length > 0 ? `/${rerooted_change_pointer}` : rerooted_change_pointer, old_value: change.old_value};
          return undo(value, rerooted_change);
        }else{//This change does not affect to this object key, so we return the current document key value
          return value;
        }
      });
    }else{
      return doc;
    }
  }
}

/**
 * This function will take the this_arg and will take the unchecked changes.
 * For the given path of the unchecked change, will take that path current value
 * and it will be compared with the current value for the change's path.
 * From that comparission we will determine if that change should be kept, or if it
 * must be removed.
 */
function checkUncheckedChanges(){
  let unchecked_change_index = this.$locals.changes.findIndex(change => change.unchecked);
  while(unchecked_change_index >= 0){
    const unchecked_change = this.$locals.changes[unchecked_change_index];
    const current_value = getPathValue(this, unchecked_change.path);
    const old_value = unchecked_change.old_value;
    if(!util.isDeepStrictEqual(current_value, old_value)){
      delete this.$locals.changes[unchecked_change_index].unchecked;
    }else{//This is not an actual change because the new value is the same than the old one
      const unchecked_change_dotted_path = unchecked_change.path.split('/').slice(1).join('.');
      this.$locals.visited = this.$locals.visited.filter(visited_dotted_path => unchecked_change_dotted_path !== visited_dotted_path);//we have to mark this path as unvisited because maybe it can change in the future
      this.$locals.changes = this.$locals.changes.filter((_, i) => i !== unchecked_change_index); //we are removing this change from the changes array because it is not an actual change.
    }
    unchecked_change_index = this.$locals.changes.findIndex(change => change.unchecked);
  }
}

/*
 * DARK MAGIC HERE. BE CAREFUL OR YOU COULD HARM YOURSELF.
 * In Mongoose there are 2 ways of updating a document:
 * A) Using model.set
 *   Example: mymodel.set('very.nested.path.here', value);
 * B) Using the dot notation
 *   Example: mymodel.very.nested.path.here = value;
 *
 * When you use 'set', this function will be call the first
 * time with with an arglist of 2 elements, the first one is
 * the path in dotted notation, and the second one is the new
 * value that is going to be given to the path.
 *
 * However this is true only for paths that are simple types,
 * and do not contain anywhere in the path any array, because
 * in such case the path is called several times.
 *
 * Thats why we have to check if we have already visited the
 * path, if we have already visited that path it is not
 * necessary to check it again because we only need the oldest
 * change.
 *
 * When you set a inner array value with the "=" assignation
 * then the arglist does not give us the new value for the
 * given path, and that's why we have to introduce an
 * unchecked change, because we cannot guarantee that the change
 * is a valid one, so we emit an event in order to check that
 * unchecked changes after the execution of the proxy middlewares
 * have finished.
 */
const proxy_handler = {
  apply: function (target, this_arg, arglist){
    if(!(this_arg.$locals.visited || []).includes(arglist[0]) && arglist[1] && !arglist[1].constructor.model){//The path has not been visited yet or it is a nested document value
      if(this_arg.$locals.visited){
        if(!arglist[1].$locals) this_arg.$locals.visited.push(arglist[0]);
      }else{
        if(!arglist[1].$locals) this_arg.$locals.visited = [arglist[0]];
      }
      if(arglist.length > 1){//This is a legit call
        const jsonpath = '/' + arglist[0].split('.').filter(p => p).join('/');
        const jsonpath_old_value = this_arg.get(arglist[0]);
        const jsonpath_new_value = arglist[1];
        if(!jsonpath_new_value.$locals){//This is not a Embbeded document
          if((this_arg.$locals.changes || []).every(change => change.path !== jsonpath) && !util.isDeepStrictEqual(jsonpath_old_value, jsonpath_new_value)){//The new value is not the same than the old value, so it is an actual change, and there is not yet any change for the given path
            const change = {path: jsonpath, old_value: jsonpath_old_value};
            if(this_arg.$locals.changes){
              this_arg.$locals.changes.unshift(change); //we insert the changes at the begining of the array because if we have to revert the changes it is not neccesary to revert the array.
            }else{
              this_arg.$locals.changes = [change];
            }
          }
        }else{//This is a embbeded document and we cannot check the new value for the given path
          if((this_arg.$locals.changes || []).every(change => change.path !== jsonpath)){//There is not any change for this path, so we can introduce it. Otherwise we skip it because if we undo the changes we are going to restore the oldest one.
            const change = {path: jsonpath, old_value: jsonpath_old_value, unchecked: true};//we are marking the changes that we could not check if they were actual changes, and we will have to check them afterwards
            if(this_arg.$locals.changes){
              this_arg.$locals.changes.unshift(change); //we insert the changes at the begining of the array because if we have to revert the changes it is not neccesary to revert the array.
            }else{
              this_arg.$locals.changes = [change];
            }
            this_arg.$locals.mtcEmitter.emit('checkUncheckedChanges');
          }
        }
      }
    }
    const newtarget = target.bind(this_arg);
    newtarget(...arglist);
  }
};

const changesTracker = schema => {
  schema.post('init', function(doc){
    const $setProxy = new Proxy(doc.$set, proxy_handler);
    const setProxy = new Proxy(doc.set, proxy_handler);
    const markModifiedProxy = new Proxy(doc.markModified, proxy_handler);
    doc.$set = $setProxy; //This is used internally by mongoose.
    doc.set = setProxy; //To intercept the calls when a document is updated using the set method, like myDocument.set('some.path', new_value);
    doc.markModified = markModifiedProxy; //To intercept document updated using the dot notation like myDocument.some.path = new_value;
    doc.$locals.mtcEmitter = new CustomEmmiter();
    doc.$locals.changes = [];
    const runCheck = () => setImmediate(checkUncheckedChanges.bind(doc));
    doc.$locals.mtcEmitter.on('checkUncheckedChanges', runCheck);
  });

  /*
   * This middleware sets the plugin when a new document is created through
   * myModel(document_definition) and it has not been saved yet to the database
   */
  schema.pre('save', function(next){
    if(this.isNew){
      const $setProxy = new Proxy(this.$set, proxy_handler);
      const setProxy = new Proxy(this.set, proxy_handler);
      const markModifiedProxy = new Proxy(this.markModified, proxy_handler);
      this.$set = $setProxy;
      this.set = setProxy;
      this.markModified = markModifiedProxy;
      this.$locals.changes = [{path: '', old_value: undefined}]
      this.$locals.mtcEmitter = new CustomEmmiter();
      const runCheck = () => setInmmediate(checkUncheckedChanges.bind(this));
      this.$locals.mtcEmitter.on('checkUncheckedChanges', runCheck);
    }
    next();
  });

  schema.pre('remove', function(next){
    this.$locals.changes = [{path: '', old_value: this}]
    next();
  });

  /**
   * This method implements the getPreviousValue function that will be available
   * for all the models generated by Mongoose. Example:
   *
   * mongoose.models.test.findOne({}).then(document => { //document => {a: 1}
   *   document.getPreviousValue('/a'); // undefined
   *   document.a = 22;
   *   document.getPreviousValue('/a'); // 1
   *   document.c = 'test';
   *   document.getPreviousValue('/c'); // undefined;
   * })
   *
   * It receives a JSON pointer path as it's only argument and it will return the previous
   * value for the given JSON pointer path. If the path has not changed, then it will
   * return undefined. If the path did not exist, because you are setting a new path
   * then it will also return undefined because the path did not exist before you set it.
   *
   * PROBLEM: Changes have been made in deeply nested paths, but we want to read a partial nested path
   * Example:
   * We have this document:
   * {
   *   a: {
   *     b: {
   *       c1: 1,
   *       c2: 2,
   *       c3: 3,
   *     }
   *   }
   * }
   *
   * And two changes have been made:
   * [
   *   {op: 'replace', path: '/a/b/c2', value: 22},
   *   {op: 'replace', path: '/a/b/c3', value: 33},
   * ]
   *
   * So the resulting document is:
   * {
   *   a: {
   *     b: {
   *       c1: 1,
   *       c2: 22,
   *       c3: 33,
   *     }
   *   }
   * }
   * And in our changes array we will have this changes:
   * [
   *   {path: '/a/b/c2', old_value: 2},
   *   {path: '/a/b/c3', old_value: 3},
   * ]
   *
   * What happens if you call my_document.getPreviousValue('/a/b')?
   * In the changes array there is not any change for the path '/a/b'
   * so it may return undefined, but this is not actually true. That's why
   * we need to take all the changes whose path starts with the requested
   * path, and revert those changes for the partial subpath that has been
   * requested.
   *
   * An optimization that can be done is to do not do this process if there
   * is any change whose path is the same as the requested path.
   *
   * @param path: String with the format JSON pointer as defined in RFC6901
   */
  schema.methods.getPreviousValue = function(path = ''){
    if(typeof(path) !== 'string'){
      throw new Error('path must be a string');
    }
    if((this.$locals.changes || []).length > 0){
      const path_change = this.$locals.changes.find(change => change.path === path); //This is for the optimization. This should be the most used case.
      if(path_change) return path_change.old_value;//This is the dessirable case
      const affected_changes = this.$locals.changes.filter(change => isAncestor(change.path, path) || isAncestor(path, change.path));
      if(affected_changes.length > 0){
        const shortest_path = affected_changes // if requested path is /a/b/c/d but there is a change for the path /a/b we have to undo the whole /a/b path to take the old value for the requested path. And the same way if the requested path is /a and there is a change that affects to /a/b/c we have to undo everything for /a. And the values that have not changed will be pointers.
          .reduce((current_shortest_path, {path}) => path.length > current_shortest_path.length ? current_shortest_path : path, path);
        const shortest_path_subdocument = shortest_path.length === 0 ? this : this.get(shortest_path.split('/').slice(1).join('.')); //This is the value that have to be reverted
        const rerooted_affected_changes = affected_changes.map(change => ({//now we have to change the path for the changes because the root document has changed.
          path: shortest_path.length > 0 ? change.path.split(shortest_path)[1] : change.path,
          old_value: change.old_value,
        }));
        const old_value = rerooted_affected_changes.reduce((reverted, change) => undo(reverted, change), shortest_path_subdocument);
        const rerooted_requested_path = path.split(shortest_path)[1] || ''; //The default value for '' is because if the requested path is already '', the shortest path will be already '' too, and ''.split('') is [], and []1 is undefined
        return getPathValue(old_value, rerooted_requested_path);
      }
    }
    return path ? this.get(path.split('/').slice(1).join('.')) : this;
  }

  /*
   * In this function we will have a similar problem than the one we had to
   * address in the previous function:
   *
   * Given a change to the path '/a/b', if the pathHasChanged function is called
   * for the path 'a/b/c/d' we cannot determine if that path has actually
   * changed or not by just checking the changes paths.
   *
   * In order to resolve this we have to check if there is a change whose's path
   * is an ancestor of the requested path. If this is the case, then we have to
   * take the whole ancestor's old value, and compare the nested old value with
   * the current nested old value and check if it is the same in order to
   * determine if the requested path has changed or not.
   *
   * @param path: String with the format JSON pointer as defined in RFC6901
   */
  schema.methods.pathHasChanged = function(path = ''){
    if(typeof(path) !== 'string'){
      throw new Error('path must be a string');
    }
    const exact_change = ((this.$locals.changes || []).find(change => change.path === path)); //This should be the most common case
    if(exact_change) return true;//
    //Ok, we are not lucky so we have to check if there is any change whose's
    //path is an ancestor for the requested path. Example change's path is /a/b
    //and the requested path is /a/b/c
    const ancestor_changes = (this.$locals.changes || []).filter(change => isAncestor(change.path, path));
    //If there are several changes that affect to ancestors, we have to check
    //all the changes because if the nearest ancestor has not the change, it
    //does not mean that another change that is a farther ancestor includes
    //a change for the nested path.
    const ancestor_changes_have_affected_to_path = ancestor_changes.some(ancestor_change => {
      //Now the old_value of the ancestor_change is where we have to
      //check if the value has changed or not, but now we cannot use the
      //requested path because if the requested path was '/a/b/c/d/e' and
      //the ancestor path is '/a/b/c', we have to check the subpath
      //'/d/e'. So we have to extract the subpath from the requested path
      const subpath = path.split(ancestor_change.path)[1];
      //Once we have the subpath, we have to read the old value, and we need
      //a function in order to achieve this because we have to take into
      //account this scenario:
      //
      //old value for path '/a/b/c' is {d: {e: 1}}; but the requested subpath
      //is /d/e/f' that path does not exist in old value, so we need a mechanism
      //that given that path returns undefined.
      const old_subpath_value = getPathValue(ancestor_change.old_value, subpath);
      if(old_subpath_value === undefined) return false; // this means that the requested subpath is not present in the old value, so that subpath has not changed
      //If we reach this line means that the subpath was present in the old value,
      //so we have to compare the old value with the current one to determine if
      //the value has changed or not.
      const mongo_nested_path = path.split('/').filter(p => p).join('.');
      const current_nested_value = this.get(mongo_nested_path);
      return !util.isDeepStrictEqual(current_nested_value, old_subpath_value);
    });
    if(ancestor_changes_have_affected_to_path) return true//This is a shortcut to avoid the next calculations
    //now we have to ckeck the other case, this means that the requested path
    //is longer than the change's path. Example, change's path is /a/b/c/d
    //but the requested path is /a/b. In this case the path /a/b has changed
    //because there is a change that affects to a descendant path. But we have not
    //guarantees that this means an actual change because it is possible that the new
    //value given to /a/b/c/d was the same value than the previous value given to
    //that path. So we are doomed to check the equality aswel, like in the first
    //conditional
    const descendant_changes = (this.$locals.changes || []).filter(change => isAncestor(path, change.path));
    if(descendant_changes.length > 0){//there are changes that are descendants of the requested path
      return descendant_changes.some(descendant_change => {
        //Now the old_value of the descendant_change is where we have to
        //check if the value has changed or not, comparing it to the
        //current change's path value. If change's path is /a/b/c/d
        //we have to check the current value for that path, and compare
        //it with the old_value to ensure that the change's value has actually changed
        //And this has to be made this way because it is nearly impossible to read
        //the new value given to a path inside the Proxy.
        const mongo_change_path = descendant_change.path.split('/').slice(1).join('.')
        const current_value_of_change_path = this.get(mongo_change_path);
        return !util.isDeepStrictEqual(current_value_of_change_path, descendant_change.old_value);
      });
    }
    return false;//there are not changes that are descendants of the requested path, and there are not any more options, so the requested path has not changed.
  }

  /**
   * This methods returns true if the current value for the given path is the
   * same value that the one received by the second arugment, and false if
   * otherwise.
   *
   * @param path: String with the format JSON pointer as defined in RFC6901
   * @param value: Any value
   * returns: Boolean.
   */
  schema.methods.is = function(path = '', value){
    return util.isDeepStrictEqual(getPathValue(this, path), value);
  }

  /**
   * This methods returns true if the previous value for the given path is was
   * the same value that the one received by the second arugment, and false if
   * otherwise.
   *
   * @param path: String with the format JSON pointer as defined in RFC6901
   * @param value: Any value
   * returns: Boolean.
   */
  schema.methods.was = function(path = '', value){
    return util.isDeepStrictEqual(this.getPreviousValue(path), value);
  }

  /**
   * This method returns a new instance of the current model and resets and injects
   * the plugin on the new generated model.
   *
   * This method is useful when you want to do further changes in a model in a
   * post middleware. If you make changes in a post middleware to the already
   * saved model, you will trigger again the pre-middlewares for that model
   * with an extra change made. However if you reacted in the pre-middlewares
   * taking into account the previous changes, then you may activate again
   * the same pre and maybe post middlewares for the given model, creating an
   * infinite loop.
   *
   * However, if you clone the document, then you are not going to repeat the
   * middlewares, but the cloned model must be injected with the plugin
   * in order to be able to register the changes that you have done in the
   * post middleware, and react to that changes in the subsequent pre
   * middlewares, but without taking into account the previous changes
   * already made.
   *
   * @returns: cloned model with the plugin inyected and changes array reset
   */
  schema.methods.clone = function(){
    const new_document = new this.constructor(this);
    const $setProxy = new Proxy(this.$set, proxy_handler);
    const setProxy = new Proxy(this.set, proxy_handler);
    const markModifiedProxy = new Proxy(new_document.markModified, proxy_handler);
    new_document.$set = $setProxy;
    new_document.set = setProxy;
    new_document.markModified = markModifiedProxy;
    new_document.$locals.mtcEmitter = new CustomEmmiter();
    const runCheck = () => setInmmediate(checkUncheckedChanges.bind(new_document));
    new_document.$locals.mtcEmitter.on('checkUncheckedChanges', runCheck);
    return new_document;
  }
}

module.exports = changesTracker;
