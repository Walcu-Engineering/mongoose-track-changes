const MONGO_URL = 'mongodb://localhost/mongoose-track-changes';
const mongoose = require('mongoose');
const changesTracker = require('./index'); 

const notificationSchema = mongoose.Schema({
  notify_at: Date,
  notify_to: [{type: mongoose.Schema.Types.ObjectId}],
  done_by: {type: mongoose.Schema.Types.ObjectId},
});

const taskSchema = new mongoose.Schema({
  notification: notificationSchema,
  created_by: {type: mongoose.Schema.Types.ObjectId},
  description: String,
  mixednode: {type: mongoose.Schema.Types.Mixed},
  numbertype: Number,
});


const AddressSchema = new mongoose.Schema({
  coordinates: new mongoose.Schema({
    lat: Number,
    lng: Number,
  }),
  url: String,
  place_id: String,
  country: String,
  area_level_1: String,
  area_level_2: String,
  area_level_3: String,
  postal_code: String,
  locality: String,
  route: String,
  street_number: String,
  address_details: String,
});

const customerSchema = mongoose.Schema({
  name: String,
  surname: String,
  theundefined: String,
  address: {
    type: AddressSchema,
    embedded_field: true,
    sub_types: ['address'],
  },
  contacts: [mongoose.Schema({
    name: {
      type: String,
      sub_types: ['name'],
    },
    phones: {
      type: [String],
      sub_types: ['phone'],
      pii: true,
    },
    emails: {
      type: [String],
      sub_types: ['email'],
      pii: true,
    },
  })],
  tasks: [taskSchema],
});

customerSchema.plugin(changesTracker);

let saved_customer;
let saved_customer_object;
let unmodified_customer;

beforeAll(async() => {
  await mongoose.connect(MONGO_URL);
  const customerModel = mongoose.model('Customer', customerSchema);
  const customer = customerModel({
    name: 'Test name',
    surname: 'Test surname',
    address: {
      coordinates: {
        lat: 40,
        lng: 1,
      },
      url: 'https://test.com',
      place_id: 'test_place_id',
      country: 'Test country',
      area_level_1: 'Test area level 1',
      area_level_2: 'Test area level 2',
      area_level_3: 'Test area level 3',
      postal_code: 'Test postal code',
      locality: 'Test locality',
      route: 'Test route',
      street_number: 'Test street number',
      address_details: 'Test address details',
    },
    contacts: [{
      name: 'Test contact 1 name',
      phones: ['Test contact 1 phone 1', 'Test contact 1 phone 2'],
      emails: ['Test contact 1 email 1', 'Test contact 1 email 2'],
    }],
    tasks: [{
      notification: {
        notify_at: new Date(),
        notify_to: new Array(3).fill(0).map(() => mongoose.Types.ObjectId()),
        done_by: mongoose.Types.ObjectId(),
      },
      created_by: mongoose.Types.ObjectId(),
      description: 'test',
      numbertype: 3,
      mixednode: {
        depth00: {
          depth10: {
            depth20: 'test',
          },
          depth11: 'test',
        },
      },
    }]
  });
  customer.injectmtc();
  await customer.save();
  unmodified_customer = customer;
  saved_customer = await mongoose.models.Customer.findOne({_id: customer._id});
  saved_customer_object = {
    _id: saved_customer._id,
    __v: saved_customer.__v,
    name: 'Test name',
    surname: 'Test surname',
    address: saved_customer.address,
    contacts: [{
      _id: saved_customer.contacts[0]._id,
      name: 'Test contact 1 name',
      phones: ['Test contact 1 phone 1', 'Test contact 1 phone 2'],
      emails: ['Test contact 1 email 1', 'Test contact 1 email 2'],
    }],
    tasks: [{
      _id: saved_customer.tasks[0]._id,
      notification: {
        _id: saved_customer.tasks[0].notification._id,
        notify_at: saved_customer.tasks[0].notification.notify_at,
        notify_to: [...saved_customer.tasks[0].notification.notify_to],
        done_by: saved_customer.tasks[0].notification.done_by,
      },
      created_by: saved_customer.tasks[0].created_by,
      description: 'test',
      numbertype: 3,
      mixednode: {
        depth00: {
          depth10: {
            depth20: 'test',
          },
          depth11: 'test',
        },
      },
    }],
  };
  return 0;
})

afterAll(async() => {
  await mongoose.disconnect();
  return 0;
});

describe('mongoose-track-changes', () => {
  describe('pathHasChanged', () => {
    describe('Update using saved_customer.set', () => {
      test('Update path "/name" with saved_customer.set("name", "New name")', () => {
        saved_customer.set('name', 'New name');
        expect(saved_customer.pathHasChanged('/name')).toBe(true);
      });
      test('Update path "/contacts/0/phones" with saved_customer.set("contacts.0.phones", ["new phone 1", "new phone 2"])', () => {
        saved_customer.set("contacts.0.phones", ["new phone 1", "new phone 2"]);
        expect(saved_customer.pathHasChanged('/contacts/0/phones')).toBe(true);
      });
      test('saved_customer.set("tasks.0.notification.notify_to.0", saved_customer.get("tasks.0.notification.notify_to.0")) is not a change', () => {
        saved_customer.set("tasks.0.notification.notify_to.0", saved_customer.get("tasks.0.notification.notify_to.0"));
        expect(saved_customer.pathHasChanged('/tasks/0/notification/notify_to/0')).toBe(false);
      });
      test('saved_customer.set("tasks.0.notification.notify_to.1", mongoose.Types.ObjectId()) checking /tasks/0/notification/notify_to/1 is true', () => {
        saved_customer.set("tasks.0.notification.notify_to.1", mongoose.Types.ObjectId());
        expect(saved_customer.pathHasChanged('/tasks/0/notification/notify_to/1')).toBe(true);
      });
    });
    describe('Update using dot notation', () => {
      test('Update path "/theundefined" with saved_custumer.theundefined = "New value"', () => {
        saved_customer.theundefined = 'New value';
        expect(saved_customer.pathHasChanged('/theundefined')).toBe(true);
      });
      test('Update path "/surname" with saved_custumer.surname = "New surname"', () => {
        saved_customer.surname = 'New surname';
        expect(saved_customer.pathHasChanged('/surname')).toBe(true);
      });
      test('Update path "/contacts/0/emails" with contacts.0.emails = ["new email 1", "new email 2"]', () => {
        saved_customer.contacts[0].emails = ["new email 1", "new email 2"];
        expect(saved_customer.pathHasChanged('/contacts/0/emails')).toBe(true);
      });
      test('saved_customer.tasks[0].notification.notify_to[2] = saved_customer.tasks[0].notification.notify_to[2] is not a change', () => {
        saved_customer.tasks[0].notification.notify_to[2] = saved_customer.tasks[0].notification.notify_to[2];
        expect(saved_customer.pathHasChanged('/tasks/0/notification/notify_to/2')).toBe(false);
      });
      test('saved_customer.tasks[0].notification.notify_to[2] = mongoose.Types.ObjectId() is a change despite we have already "updated" that path', () => {
        saved_customer.tasks[0].notification.notify_to[2] = mongoose.Types.ObjectId();
        expect(saved_customer.pathHasChanged('/tasks/0/notification/notify_to/2')).toBe(true);
      });
      test('saved_customer.tasks.0.notification.notify_to.1" = mongoose.Types.ObjectId() checking /tasks/0/notification/notify_to/1 is true', () => {
        saved_customer.tasks[0].notification.notify_to[1] = mongoose.Types.ObjectId();
        expect(saved_customer.pathHasChanged('/tasks/0/notification/notify_to/1')).toBe(true);
      });
    });
    test('Check that path "/contacts/0" has changed because we have changed a descendant path before', () => {
      expect(saved_customer.pathHasChanged('/contacts/0')).toBe(true);
    });
    test('Check that path "/contacts" has changed because we have changed a descendant path before', () => {
      expect(saved_customer.pathHasChanged('/contacts')).toBe(true);
    });
    test('Check that path "/address" has not changed', () => {
      expect(saved_customer.pathHasChanged('/address')).toBe(false);
    });
    test('Check that path "/test" that does not exists has not changed', () => {
      expect(saved_customer.pathHasChanged('/test')).toBe(false);
    });
  });
  describe('getPreviousValue', () => {
    test('/theundefined previous value should be undefined', () => {
      const prev = saved_customer.getPreviousValue('/theundefined');
      expect(prev).toBe(undefined);
    });
    test('/contacts/0/phones previous value should be ["Test contact 1 phone 1", "Test contact 1 phone 2"]', () => {
      const prev = saved_customer.getPreviousValue('/contacts/0/phones');
      expect(prev).toEqual(["Test contact 1 phone 1", "Test contact 1 phone 2"]);
    });
    test('/contacts/0/phones/0 previous value should be "Test contact 1 phone 1"', () => {
      const prev = saved_customer.getPreviousValue('/contacts/0/phones/0');
      expect(prev).toEqual("Test contact 1 phone 1");
    });
    test('/contacts/0 previous value should be {name: "Test contact 1 name", phones: ["Test contact 1 phone 1", "Test contact 1 phone 2"], emails: ["Test contact 1 email 1", "Test contact 1 email 2"]}', () => {
      const prev = saved_customer.getPreviousValue('/contacts/0');
      const control = {
        _id: saved_customer.contacts[0]._id,
        name: 'Test contact 1 name',
        phones: ['Test contact 1 phone 1', 'Test contact 1 phone 2'],
        emails: ['Test contact 1 email 1', 'Test contact 1 email 2'],
      };
      expect(prev).toEqual(control);
    });
    test('prev_doc', () => {
      const prev = saved_customer.getPreviousValue('');
      expect(prev).toEqual(saved_customer_object);
    });
    test('prev_doc without changes. Should return undefined', () => {
      expect(unmodified_customer.getPreviousValue('')).toBe(undefined);
    });
    test('Prev deep path value without changes. Should return undefined', () => {
      expect(unmodified_customer.getPreviousValue('/deep/path')).toBe(undefined);
    });
  });
  describe('was', () => {
    test('was("/conctacts/0/phones", ["Test contact 1 phone 1", "Test contact 1 phone 2"]) should be true', () => {
      expect(saved_customer.was('/contacts/0/phones', ["Test contact 1 phone 1", "Test contact 1 phone 2"])).toBe(true);
    });
    test('was("/conctacts/0/phones", ["new phone 1", "new phone 2"]) should be false', () => {
      expect(saved_customer.was('/contacts/0/phones', ["new phone 1", "new phone 2"])).toBe(false);
    });
  });
  describe('is', () => {
    test('is("/conctacts/0/phones", ["Test contact 1 phone 1", "Test contact 1 phone 2"]) should be false', () => {
      expect(saved_customer.is('/contacts/0/phones', ["Test contact 1 phone 1", "Test contact 1 phone 2"])).toBe(false);
    });
    test('is("/conctacts/0/phones", ["new phone 1", "new phone 2"]) should be true', () => {
      expect(saved_customer.is('/contacts/0/phones', ["new phone 1", "new phone 2"])).toBe(true);
    });
  });
});

