
# mongoose-track-changes

This is a [Mongoose](https://github.com/Automattic/mongoose) plugin that tracks every change that is made to a model at runtime in a transparent
way for the developer. It allows to restore the previous value for any given path, or check if a given path has changed
in a very easy, performant and efficient way.

## Installation and usage
For install this plugin at this moment we do not provide a npm package, so you will need to do the following:
```bash
npm i --save https://github.com/Walcu-Engineering/mongoose-track-changes
```
To use the plugin in your code base:
```javascript
const trackChangesPlugin = require('mongoose-track-changes');
const mongoose = require('mongoose');

const notificationSchema = mongoose.Schema({
  notify_at: Date,
  notify_to: [{type: mongoose.Schema.Types.ObjectId}],
  done_by: {type: mongoose.Schema.Types.ObjectId},
});

notificationSchema.plugin(trackChangesPlugin);

notificationSchema.pre('save', function(next){
  if(this.pathHasChanged('/done_by')){
    this.set('notify_to', [this.getPreviousValue('/done_by')]);
  }
  next();
});
```

## `Change` specification
Each change is an object with 2 keys:

**- `path`**
A string representing a path in JSON Pointer format as defined by the [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)

**- `old_value`**
Any value representing the previous value that there was in the path specified in the `path` key described above.

## Are the changes stored in the database?
The changes array is not stored in the database, this array only lives at runtime in `$locals.changes` document path.

## What if I want to store the changes in the database?
This plugin does not support this feature right now and we do not guarantee that this feature will be implemented in the future.

## Where do the changes live?
All the changes are stored in an `array` at runtime in the `$locals.changes` property of the document model.

## How do I work with the changes?
You don't need to work with the `$locals.changes` array because this plugin injects 2 helper methods to every
document that will be enough to achieve whatever you wish to accomplish.
## Helpers
This plugin provide two helper methods available in all models, and they should be enough to achieve whatever you wish:
### `pathHasChanged`
  **Parameters**

  - `path`: (Optional) A string representing a path in JSON Pointer format as defined by the [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)
    *Default value is empty string because according to the [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901) empty string stands for the root path*

  **Returns**
  - `true`: If the `path` specified in the parameter has changed.
  - `false`: If the `path` specified in the parameter **has not** changed

  **Example**
  ```javascript
  const mtc = require('mongoose-track-changes');
  const mongoose = require('mongoose');

  const notificationSchema = mongoose.Schema({
    notify_at: Date,
    notify_to: [{type: mongoose.Schema.Types.ObjectId}],
    done_by: {type: mongoose.Schema.Types.ObjectId},
  });

  notificationSchema.plugin(mtc);

  mongoose.connect(process.env.MONGO_URL)
    .then(() => {
      const notificationModel = mongoose.model('Notification', notificationSChema);
      const notification = notificationModel({
        notify_at: new Date(),
        notify_to: new Array(3).fill(0).map(() => mongoose.Types.ObjectId()),
        done_by: mongoose.Types.ObjectId(),
      });
      return notification.save();
    }).then(saved_notification => {
      saved_notification.done_by = mongoose.Types.ObjectId();
      saved_notification.set('notify_at', new Date());
      console.log(saved_notification.pathHasChanged('/done_by'));
      //Prints true
      console.log(saved_notification.pathHasChanged('/notify_at'));
      //Prints true
      console.log(saved_notification.pathHasChanged('')); //The root path
      //Prints true
      console.log(saved_notification.pathHasChanged('/notify_to'))
      //Prints false
      console.log(saved_notification.pathHasChanged('/non/existing/path'))
      //Prints false
    }).then(() => {
      mongoose.disconnect();
    });
  ```
---
### `getPreviousValue`
  **Parameters**
  - `path`: (Optional) A string representing a path in JSON Pointer format as defined by the [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)
      *Default value is empty string because according to the [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901) empty string stands for the root path*

  **Returns**
  The previous value for the given path, but we aware of this very important point:
  all the descendant paths of the requested path that have not changed, **will be pointers to the current values**,
  and only the actual paths that have changed will have new data.

  This means that if you get the previous value for a path that has descendant nodes that have not changed, and then you make
  changes to those nodes in the original document, in the previous value those changes will appear as well.

  And in the same way, if you make changes in the object generated by `getPreviousValue`, to paths that have not changed in the
  original document, those changes will affect to the original document as well.

  So be careful, and **if you want to make any change to that value, make sure that you make deep clone of it.**

  **Example**
  For simplification.Let's say that we have this document:
  ```javascript
  const mydocument = {
    a0: {
      b0: {
        c0: {
          d0: {
            e0: '/a0/b0/c0/d0/e0 original value'
          }
        },
        c1: {
          d0: '/a0/b0/c1/d0 original value'
        }
      }
    },
    a1: {
      b0: '/a1/b0 original value',
      b1: '/a1/b1 original value'
    }
  }
  ```
  And we do a single change:
  ```javascript
  mydocument.a0.b0.c0.d0.e0 = '/a0/b0/c0/d0/e0 new value';
  ```
  So now the document is:
  ```javascript
  {
    a0: {
      b0: {
        c0: {
          d0: {
            e0: '/a0/b0/c0/d0/e0 new value'
          }
        },
        c1: {
          d0: '/a0/b0/c1/d0 original value'
        }
      }
    },
    a1: {
      b0: '/a1/b0 original value',
      b1: '/a1/b1 original value'
    }
  }
  ```
  And we have a single change that is
  ```javascript
  {path: '/a0/b0/c0/d0/e0', old_value: '/a0/b0/c0/d0/e0 original value'}
  ```
  So now if we want the previous value for the path `/a0/b0/c0/d0/e0`:
  ```javascript
  mydocument.getPreviousValue('/a0/b0/c0/d0/e0');
  ```
  The result will be just `'/a0/b0/c0/d0/e0 original value'`, but if you call the function with `'/a0/b0'`
  ```javascript
  const prev = mydocument.getPreviousValue('/a0/b0');
  ```
  Then `prev` result will be
  ```javascript
  {
    c0: {
      d0: {
        e0: '/a0/b0/c0/d0/e0 original value'
      }
    },
    c1: {//Pointer to the original value because this branch has not changed
      d0: '/a0/b0/c1/d0 original value'
    }
  }
  ```
  And if for some reason you update the original document like this:
  ```javascript
  const prev = original.getPreviousValue('/a0/b0');
  console.log(prev.c1.d0)
  //Prints '/a0/b0/c1/d0 original value'
  original.a0.b0.c1.d0 = 'changed after getting prev'.
  console.log(prev.c1.d0);
  //Prints 'changed after getting prev'.
  prev.c1.d0 = 'I am changing this from the prev';
  console.log(original.a0.b0.c1.d0);
  //Prints 'I am changing this from the prev'
  ```
  So be very very careful with this.

## Other technical questions
### The changes are stored in any particular order?
Yes. The changes are inserted at the begining of the changes array because when the changes are undone we undo every
change that affects to the requested path, in the reverted order, this means that we first undo the last inserted change
and the last change that will be reverted will be the first change that affects to the requested path.
This is done this way because we are seeking for the best performance and this way we do not have to revert the changes array.

### Why do you use the [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901) JSON Pointer specification for the paths instead of the standard MongoDB dotted path format?
This plugin firstly was developed to resolve a problem that we have faced at [Walcu](https://walcu.com), and in Walcu we internally
use the [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901) JSON Pointer specification for the paths, so for us is natural
to work with this standard. And as we were seeking for performance, if we stored the path in the MongoDB dotted format, we had
to convert from [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901) format to the MongoDB dotted format, losing some performance.

When we though about publishig this plugin, we though to support both formats, but we wanted to keep things simple
(eventhough the implementation of the core concepts of this plugin is not simple at all).

### This looks cool. Where can I read more information about the implementation?
You can read the code and the comments where many of the tricky and dark magic things are explained through the comments.
