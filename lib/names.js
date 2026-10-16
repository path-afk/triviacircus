'use strict';
/**
 * Trivia Circus — guest name generator.
 * Uses crypto.randomInt (CSPRNG) for uniform, unpredictable selection.
 * lib/db.js enforces UNIQUE COLLATE NOCASE and retries on collision.
 */
const { randomInt } = require('crypto');

const ADJECTIVES = [
  'Absent','Ancient','Anxious','Artful','Bashful','Bold','Brazen','Breezy','Bright',
  'Bumbling','Calm','Candid','Cautious','Clever','Clumsy','Crafty','Cunning','Daring',
  'Dashing','Devious','Dizzy','Dramatic','Eager','Earnest','Eccentric','Elusive',
  'Faithful','Famous','Fancy','Fearless','Feisty','Feral','Fierce','Flighty','Foolish',
  'Frantic','Furtive','Gentle','Gloomy','Grumpy','Guileful','Hasty','Humble','Hungry',
  'Impish','Infamous','Joyful','Jolly','Lanky','Laughing','Lazy','Lofty','Lonely',
  'Loud','Loyal','Lucky','Lying','Mellow','Mighty','Mischievous','Mysterious',
  'Nervous','Noble','Noisy','Odd','Outrageous','Patient','Peculiar','Phantom',
  'Plucky','Pompous','Proud','Puzzled','Quiet','Radiant','Reckless','Restless',
  'Rogue','Rowdy','Rugged','Sassy','Savage','Scheming','Serene','Shady','Shifty',
  'Shy','Sly','Sneaky','Solemn','Spooky','Sprightly','Stealthy','Stoic','Stormy',
  'Stubborn','Swift','Timid','Tiny','Tired','Tricky','Truthful','Turbulent',
  'Unruly','Valiant','Vexed','Vigilant','Wary','Weary','Whimsical','Wily','Wise',
  'Witty','Woeful','Zealous'
];

const ANIMALS = [
  'Albatross','Armadillo','Axolotl','Badger','Bandicoot','Barracuda','Basilisk',
  'Bison','Blobfish','Bobcat','Buffalo','Capybara','Cassowary','Chameleon',
  'Cheetah','Chinchilla','Chipmunk','Condor','Coyote','Crocodile','Dingo',
  'Dugong','Eagle','Echidna','Falcon','Ferret','Flamingo','Flounder','Fox',
  'Gecko','Gnu','Gorilla','Hamster','Hedgehog','Hyena','Ibis','Iguana',
  'Jackal','Jaguar','Jellyfish','Komodo','Lemur','Leopard','Llama','Lobster',
  'Lynx','Manatee','Mandrill','Marmot','Mongoose','Moose','Narwhal','Newt',
  'Ocelot','Octopus','Opossum','Ostrich','Otter','Panda','Pangolin','Parrot',
  'Pelican','Piranha','Platypus','Porcupine','Porpoise','Quokka','Raccoon',
  'Rattlesnake','Rhino','Salamander','Seahorse','Skunk','Sloth','Squid',
  'Stoat','Tapir','Tarantula','Tiger','Toucan','Viper','Vulture','Walrus',
  'Warthog','Weasel','Wolf','Wolverine','Wombat','Yak','Zebra'
];

/** Generate one candidate name — NOT uniqueness-checked here; caller retries. */
function generate() {
  return ADJECTIVES[randomInt(ADJECTIVES.length)] + ' ' + ANIMALS[randomInt(ANIMALS.length)];
}

const COMBINATION_COUNT = ADJECTIVES.length * ANIMALS.length;

module.exports = { generate, ADJECTIVES, ANIMALS, COMBINATION_COUNT };
