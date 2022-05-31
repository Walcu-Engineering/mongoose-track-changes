const util = require('util');

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

/*
 * DARK MAGIC HERE. BE CAREFUL OR YOU COULD HARM YOURSELF.
 * The first thing that we do inside the Proxy is to throw an error
 * because we want the stack trace. This means that we want to know from
 * where this function has been called from, and the only way to know this
 * is from an error stack property.
 *
 * WHY DO WE NEED TO KNOW WHERE THIS FUNCTION HAS BEEN CALLED FROM?
 *
 * In Mongoose there are 2 ways of updating a document:
 * A) Using model.set
 *   Example: mymodel.set('very.nested.path.here', value);
 * B) Using the dot notation
 *   Example: mymodel.very.nested.path.here = value;
 * When you update a inner array using model.set mongoose calls recursively
 * _markModified for every single path path, and when a inner path part is an
 * array, Mongoose Proxies the Array, marks it with Proxy._markModified using
 * the key as the root path.
 *
 * What does this mean?
 * This means that if you update a document like this: 
 * mymodel.set('very.nested.path.here', value) the path 'very.nested.path.here'
 * is an array, eventually this function will be called with the path 'here' as
 * if 'here' was a valid path, and it is not. This only happens when you want to
 * update a deeply nested path that is an array and you want to change the whole
 * array and the only way to detect this is to check in the call stack if there
 * is any call to Proxy._markModified. However if the path is a single nested like
 * {a: ['elem1', 'elem2']} there will be also a call for the path 'a' as the root
 * path that will match the condition described above, and for this case will be
 * legitime, but we don't care becasue this will be detected firstly by the set
 * proxied call.
 *
 * So, if the "set" function is used to update a document, then this function
 * will be called by both, set and markModified. That's why we have to check
 * if a change already exists in the array.
 *
 * And if a document is updated with the dot notation, then only markModified is used.
 */
const proxy_handler = {
  apply: function (target, this_arg, arglist){
    let stack = [];
    try {
      throw new Error();
    }catch(error){
      stack = error.stack.split('\n').slice(1).map(stack_line => stack_line.split('at')[1].trim().split(' ')[0]);
    }
    if(stack.every(call => call !== 'Proxy._markModified')){
      const path = '/' + arglist[0].split('.').filter(p => p).join('/');
      const old_value = this_arg.get(arglist[0]);
      const change = {path, old_value};
      if(this_arg._changes){
        if(!this_arg._changes.some(change => change.path === path && util.isDeepStrictEqual(old_value, change.old_value))){//This change does not exist yet. (the same change could already exist because markModified is recursive
          this_arg._changes.unshift(change); //we insert the changes at the beggining of the array because if we have to revert the changes it is not neccesary to revert the array.
        }
      }else{
        this_arg._changes = [change];
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
      this._changes = [{op: 'replace', path: '', old_value: undefined}]
    }
    next();
  });

  schema.pre('remove', function(next){
    this._changes = [{op: 'replace', path: '', old_value: this}]
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
    if((this._changes || []).length > 0){
      const path_change = this._changes.find(change => change.path === path); //This is for the optimization. This should be the most used case.
      if(path_change) return path_change.old_value;//This is the dessirable case
      const affected_changes = this._changes.filter(change => isAncestor(change.path, path) || isAncestor(path, change.path));
      if(affected_changes.length > 0){
        const shortest_path = affected_changes // if requested path is /a/b/c/d but there is a change for the path /a/b we have to undo the whole /a/b path to take the old value for the requested path. And the same way if the requested path is /a and there is a change that affects to /a/b/c we have to undo everything for /a. And the values that have not changed will be pointers.
          .reduce((current_shortest_path, {path}) => path.length > current_shortest_path.length ? current_shortest_path : path, path);
        const shortest_path_subdocument = shortest_path.length === 0 ? this : this.get(shortest_path.split('/').slice(1).join('.')); //This is the value that have to be reverted
        const rerooted_affected_changes = affected_changes.map(change => {//now we have to change the path for the changes because the root document has changed.
          change.path = path.length > 0 ? change.path.split(shortest_path)[1] : change.path;
          return change;
        });
        const old_value = rerooted_affected_changes.reduce((reverted, change) => undo(reverted, change), shortest_path_subdocument);
        const rerooted_requested_path = path.split(shortest_path)[1];
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
  schema.methods.pathHasChanged = function(path){
    if(typeof(path) !== 'string'){
      throw new Error('path must be a string');
    }
    const exact_change = ((this._changes || []).find(change => change.path === path)); //This should be the most common case
    if(exact_change && !util.isDeepStrictEqual(exact_change.old_value, this.get(exact_change.path.split('/').slice(1).join('.')))) return true;//we have to do this ugly comparission because the plugin is not able to detecte if a change is giving the same value to the given path than the value that was previous set to that path.
    //Ok, we are not lucky so we have to check if there is any change whose's
    //path is an ancestor for the requested path. Example change's path is /a/b
    //and the requested path is /a/b/c
    const ancestor_changes = (this._changes || []).filter(change => isAncestor(change.path, path));
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
    const descendant_changes = (this._changes || []).filter(change => isAncestor(path, change.path));
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
}

module.exports = changesTracker;
