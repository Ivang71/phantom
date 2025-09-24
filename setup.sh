# setting up node
sudo apt update
sudo apt install curl git -y
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
nvm install --lts
npm install -g npm@latest
npm install --global yarn

sudo apt install node-typescript -y


# Configure journald limits
echo "Configuring journald limits..."
sudo mkdir -p /etc/systemd/journald.conf.d
echo -e "[Journal]\nStorage=persistent\nSystemMaxUse=1G\nRuntimeMaxUse=200M\nMaxRetentionSec=7day\nSystemKeepFree=10%" | sudo tee /etc/systemd/journald.conf.d/limits.conf
sudo mkdir -p /var/log/journal
sudo systemctl restart systemd-journald


#settings up playwright
npx --yes playwright install --with-deps
npx --yes playwright install webkit


# setting up project
yarn
