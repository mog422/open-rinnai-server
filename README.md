# open-rinnai-server

Rannai is a well-known boiler company in South Korea and one of the features that Rinnai offers is remote control from your personal devices, in short, the IoT service. However there is no guarantee that Rannai will continue to support and update their IoT service of the boilers they sold, or security incident will happen. To avoid these concerns, this repo allows you to run it on your own local network and emulates their main server for not using their app, but through RESTful APIs or home assistant this repo provides.

## How to use it
* `npm run build`
* `node app`

If you have a local network DNS server, set `wifiboilers1.rinnai.co.kr` to point open-rinnai-server.

If your home network router is Linux-based, `iptables -t nat -A PREROUTING -s <ROOM CONTROLLER IP> -p tcp --dport 9105 -j DNAT --to-destination <open-rinnai-server IP>`

Default port
* Boiler Control Port 9105
* RESTful API port 8081

Warning! Do not expose these ports publicly without any authentication.

## DISCLAIMER
This repo is mainly tested on Rinnai WF-S100. I am not responsible for any incidents or, explosions might happen by using this repo.
